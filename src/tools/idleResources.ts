import { z } from "zod";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeRegionsCommand,
  type Instance,
} from "@aws-sdk/client-ec2";
import {
  RDSClient,
  DescribeDBInstancesCommand,
} from "@aws-sdk/client-rds";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Datapoint,
} from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { createLogger, getAwsCredentialContext, serializeError, type Logger } from "../utils/fileLogger.js";

const log = createLogger("idleResources");
const ceClient = new CostExplorerClient({});

const CPU_IDLE_THRESHOLD = 5;
const RDS_CONNECTION_IDLE_THRESHOLD = 2;
const METRIC_LOOKBACK_BUFFER_DAYS = 2;
const COST_LOOKBACK_DAYS = 30;
const CE_RESOURCE_ID_BATCH_SIZE = 100;
const EC2_COMPUTE_SERVICE = "Amazon Elastic Compute Cloud - Compute";
const RDS_SERVICE = "Amazon Relational Database Service";
const EBS_SERVICE = "Amazon Elastic Compute Cloud - Other";

export const idleResourcesSchema = z.object({
  resource_type: z.enum(["all", "ec2", "rds", "ebs"]).default("all"),
  min_idle_days: z.number().default(7),
});

export type IdleResourcesInput = z.infer<typeof idleResourcesSchema>;

interface Ec2IdleResource {
  instance_id: string;
  name: string;
  type: string;
  region: string;
  avg_cpu: string;
  days_idle: number;
  recommendation: string;
  monthly_cost?: string;
  potential_monthly_savings?: string;
  potential_annual_savings?: string;
  cost_unavailable?: boolean;
}

interface RdsIdleResource {
  instance_id: string;
  name: string;
  type: string;
  region: string;
  avg_connections: number;
  days_idle: number;
  recommendation: string;
  monthly_cost?: string;
  potential_monthly_savings?: string;
  potential_annual_savings?: string;
  cost_unavailable?: boolean;
}

interface EbsIdleResource {
  volume_id: string;
  size: string;
  region: string;
  days_unattached: number;
  recommendation: string;
  monthly_cost?: string;
  potential_monthly_savings?: string;
  potential_annual_savings?: string;
  cost_unavailable?: boolean;
}

function daysBetween(from: Date, to: Date): number {
  const diffMs = to.getTime() - from.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function getTagName(tags: { Key?: string; Value?: string }[] | undefined, fallback: string): string {
  const nameTag = tags?.find((t) => t.Key === "Name");
  return nameTag?.Value ?? fallback;
}

function formatCost(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getCostDateRange(): { Start: string; End: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - COST_LOOKBACK_DAYS);

  return {
    Start: start.toISOString().split("T")[0]!,
    End: end.toISOString().split("T")[0]!,
  };
}

async function fetchResourceCosts(
  requestLog: Logger,
  resourceIds: string[],
  service: string,
  resourceLabel: string
): Promise<Map<string, number>> {
  const costByResource = new Map<string, number>();

  if (resourceIds.length === 0) {
    return costByResource;
  }

  const timePeriod = getCostDateRange();

  requestLog.info(`Fetching ${resourceLabel} costs from Cost Explorer`, {
    resource_count: resourceIds.length,
    service,
    cost_period: timePeriod,
    lookback_days: COST_LOOKBACK_DAYS,
  });

  for (let i = 0; i < resourceIds.length; i += CE_RESOURCE_ID_BATCH_SIZE) {
    const batch = resourceIds.slice(i, i + CE_RESOURCE_ID_BATCH_SIZE);
    const batchNumber = Math.floor(i / CE_RESOURCE_ID_BATCH_SIZE) + 1;

    requestLog.debug("Cost Explorer batch request", {
      resource_label: resourceLabel,
      batch_number: batchNumber,
      batch_size: batch.length,
      resource_ids: batch,
    });

    const startMs = Date.now();
    const response = await ceClient.send(
      new GetCostAndUsageCommand({
        TimePeriod: timePeriod,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        Filter: {
          And: [
            {
              Dimensions: {
                Key: "SERVICE",
                Values: [service],
              },
            },
            {
              Dimensions: {
                Key: "RESOURCE_ID",
                Values: batch,
              },
            },
          ],
        },
        GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
      })
    );
    const durationMs = Date.now() - startMs;

    let batchMatchCount = 0;
    for (const timeResult of response.ResultsByTime ?? []) {
      for (const group of timeResult.Groups ?? []) {
        const resourceId = group.Keys?.[0];
        if (!resourceId) continue;

        const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? "0");
        costByResource.set(resourceId, (costByResource.get(resourceId) ?? 0) + amount);
        batchMatchCount += 1;
      }
    }

    requestLog.info("Cost Explorer batch completed", {
      resource_label: resourceLabel,
      batch_number: batchNumber,
      duration_ms: durationMs,
      matches_in_batch: batchMatchCount,
      response_metadata: response.$metadata ?? null,
    });
  }

  requestLog.info(`${resourceLabel} cost fetch complete`, {
    resources_requested: resourceIds.length,
    resources_with_cost_data: costByResource.size,
    total_cost_usd: [...costByResource.values()].reduce((sum, c) => sum + c, 0),
  });

  return costByResource;
}

function resolveResourceCost(
  costByResource: Map<string, number>,
  ...lookupIds: (string | undefined)[]
): number | undefined {
  for (const id of lookupIds) {
    if (!id) continue;
    const cost = costByResource.get(id);
    if (cost !== undefined && cost > 0) return cost;
  }
  return undefined;
}

function enrichWithCosts<T extends { region: string; recommendation: string }>(
  requestLog: Logger,
  resources: T[],
  costByResource: Map<string, number>,
  resourceLabel: string,
  savingsNoun: string,
  getLookupIds: (resource: T) => (string | undefined)[],
  savingsAction: string
): { instances: (T & {
  monthly_cost?: string;
  potential_monthly_savings?: string;
  potential_annual_savings?: string;
  cost_unavailable?: boolean;
  recommendation: string;
})[]; totalMonthlySavings: number } {
  let totalMonthlySavings = 0;
  let withCost = 0;
  let withoutCost = 0;

  const enriched = resources.map((resource) => {
    const lookupIds = getLookupIds(resource);
    const cost = resolveResourceCost(costByResource, ...lookupIds);

    if (cost === undefined) {
      withoutCost += 1;
      requestLog.debug(`No Cost Explorer data for idle ${resourceLabel}`, {
        lookup_ids: lookupIds,
        region: resource.region,
      });

      return {
        ...resource,
        cost_unavailable: true,
        recommendation: `${resource.recommendation} Actual cost data unavailable — ensure resource-level cost data is enabled in Cost Explorer.`,
      };
    }

    withCost += 1;
    totalMonthlySavings += cost;

    const monthlySavings = formatCost(cost);
    const annualSavings = formatCost(cost * 12);

    return {
      ...resource,
      monthly_cost: monthlySavings,
      potential_monthly_savings: monthlySavings,
      potential_annual_savings: annualSavings,
      recommendation: `${resource.recommendation} Actual ${savingsNoun} spend (last ${COST_LOOKBACK_DAYS} days): ${monthlySavings}. ${savingsAction} could save ${monthlySavings}/month (${annualSavings}/year).`,
    };
  });

  requestLog.info(`${resourceLabel} cost enrichment complete`, {
    resources_enriched: withCost,
    resources_without_cost: withoutCost,
    total_potential_monthly_savings: totalMonthlySavings,
    total_potential_annual_savings: totalMonthlySavings * 12,
  });

  return { instances: enriched, totalMonthlySavings };
}

async function getEnabledRegions(requestLog: Logger): Promise<string[]> {
  const ec2 = new EC2Client({});
  const response = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));

  const regions = (response.Regions ?? [])
    .filter((r) => r.OptInStatus === "opt-in-not-required" || r.OptInStatus === "opted-in")
    .map((r) => r.RegionName)
    .filter((r): r is string => Boolean(r));

  requestLog.info("Resolved enabled AWS regions", { region_count: regions.length, regions });
  return regions;
}

async function getDailyMetricAverages(
  requestLog: Logger,
  region: string,
  namespace: string,
  metricName: string,
  dimensionName: string,
  dimensionValue: string,
  lookbackDays: number
): Promise<Datapoint[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - lookbackDays - METRIC_LOOKBACK_BUFFER_DAYS);

  const cw = new CloudWatchClient({ region });

  requestLog.debug("Fetching CloudWatch metric", {
    region,
    namespace,
    metric_name: metricName,
    dimension: `${dimensionName}=${dimensionValue}`,
    lookback_days: lookbackDays,
  });

  const response = await cw.send(
    new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: [{ Name: dimensionName, Value: dimensionValue }],
      StartTime: start,
      EndTime: end,
      Period: 86400,
      Statistics: ["Average"],
    })
  );

  const datapoints = (response.Datapoints ?? []).sort(
    (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0)
  );

  requestLog.debug("CloudWatch metric received", {
    region,
    dimension_value: dimensionValue,
    datapoint_count: datapoints.length,
  });

  return datapoints;
}

function countIdleDaysFromDatapoints(
  datapoints: Datapoint[],
  isIdle: (value: number) => boolean
): { idleDays: number; average: number } {
  if (datapoints.length === 0) {
    return { idleDays: 0, average: 0 };
  }

  const values = datapoints.map((d) => d.Average ?? 0);
  const average = values.reduce((sum, v) => sum + v, 0) / values.length;
  const idleDays = datapoints.filter((d) => isIdle(d.Average ?? 0)).length;

  return { idleDays, average };
}

async function findIdleEc2InRegion(
  requestLog: Logger,
  region: string,
  minIdleDays: number
): Promise<Ec2IdleResource[]> {
  const ec2 = new EC2Client({ region });
  const response = await ec2.send(new DescribeInstancesCommand({}));
  const instances: Instance[] = [];

  for (const reservation of response.Reservations ?? []) {
    instances.push(...(reservation.Instances ?? []));
  }

  requestLog.debug("EC2 instances listed", { region, instance_count: instances.length });

  const running = instances.filter((i) => i.State?.Name === "running" && i.InstanceId);
  const idleResources: Ec2IdleResource[] = [];

  for (const instance of running) {
    const instanceId = instance.InstanceId!;
    const datapoints = await getDailyMetricAverages(
      requestLog,
      region,
      "AWS/EC2",
      "CPUUtilization",
      "InstanceId",
      instanceId,
      minIdleDays
    );

    const { idleDays, average } = countIdleDaysFromDatapoints(
      datapoints,
      (value) => value < CPU_IDLE_THRESHOLD
    );

    if (idleDays < minIdleDays) continue;

    const instanceType = instance.InstanceType ?? "unknown";
    const name = getTagName(instance.Tags, instanceId);

    idleResources.push({
      instance_id: instanceId,
      name,
      type: instanceType,
      region,
      avg_cpu: `${average.toFixed(1)}%`,
      days_idle: idleDays,
      recommendation: `Stop or terminate — average CPU utilization has been ${average.toFixed(1)}% with ${idleDays} low-utilization days. Review whether this workload can be stopped, rightsized, or replaced with a smaller instance type.`,
    });

    requestLog.debug("Idle EC2 instance identified", {
      region,
      instance_id: instanceId,
      instance_type: instanceType,
      idle_days: idleDays,
      avg_cpu: average,
    });
  }

  return idleResources;
}

async function findIdleRdsInRegion(
  requestLog: Logger,
  region: string,
  minIdleDays: number
): Promise<RdsIdleResource[]> {
  const rds = new RDSClient({ region });
  const response = await rds.send(new DescribeDBInstancesCommand({}));
  const instances = response.DBInstances ?? [];

  requestLog.debug("RDS instances listed", { region, instance_count: instances.length });

  const idleResources: RdsIdleResource[] = [];

  for (const db of instances) {
    if (!db.DBInstanceIdentifier || db.DBInstanceStatus !== "available") continue;

    const datapoints = await getDailyMetricAverages(
      requestLog,
      region,
      "AWS/RDS",
      "DatabaseConnections",
      "DBInstanceIdentifier",
      db.DBInstanceIdentifier,
      minIdleDays
    );

    const { idleDays, average } = countIdleDaysFromDatapoints(
      datapoints,
      (value) => value < RDS_CONNECTION_IDLE_THRESHOLD
    );

    if (idleDays < minIdleDays) continue;

    const instanceClass = db.DBInstanceClass ?? "unknown";

    idleResources.push({
      instance_id: db.DbiResourceId ?? db.DBInstanceIdentifier,
      name: db.DBInstanceIdentifier,
      type: instanceClass,
      region,
      avg_connections: Math.round(average * 10) / 10,
      days_idle: idleDays,
      recommendation: `Downsize or delete — average database connections have been ${average.toFixed(1)} over ${idleDays} days. Consider a smaller instance class, stopping non-production databases, or taking a snapshot and terminating if unused.`,
    });

    requestLog.debug("Idle RDS instance identified", {
      region,
      db_instance: db.DBInstanceIdentifier,
      instance_class: instanceClass,
      idle_days: idleDays,
      avg_connections: average,
    });
  }

  return idleResources;
}

async function findUnattachedEbsInRegion(
  requestLog: Logger,
  region: string,
  minIdleDays: number
): Promise<EbsIdleResource[]> {
  const ec2 = new EC2Client({ region });
  const response = await ec2.send(
    new DescribeVolumesCommand({
      Filters: [{ Name: "status", Values: ["available"] }],
    })
  );

  const volumes = response.Volumes ?? [];
  requestLog.debug("Unattached EBS volumes listed", { region, volume_count: volumes.length });

  const now = new Date();
  const idleResources: EbsIdleResource[] = [];

  for (const volume of volumes) {
    if (!volume.VolumeId) continue;

    const createTime = volume.CreateTime ?? now;
    const daysUnattached = daysBetween(createTime, now);

    if (daysUnattached < minIdleDays) continue;

    const sizeGb = volume.Size ?? 0;

    idleResources.push({
      volume_id: volume.VolumeId,
      size: `${sizeGb} GB`,
      region,
      days_unattached: daysUnattached,
      recommendation: `Delete or snapshot — volume has been unattached (available) for approximately ${daysUnattached} days (estimated from create time). Create a snapshot if data may be needed, then delete the volume.`,
    });

    requestLog.debug("Unattached EBS volume identified", {
      region,
      volume_id: volume.VolumeId,
      size_gb: sizeGb,
      days_unattached: daysUnattached,
    });
  }

  return idleResources;
}

async function scanRegion(
  requestLog: Logger,
  region: string,
  input: IdleResourcesInput
): Promise<{
  ec2: Ec2IdleResource[];
  rds: RdsIdleResource[];
  ebs: EbsIdleResource[];
}> {
  const regionLog = requestLog.child({ region });
  const startMs = Date.now();

  regionLog.info("Scanning region for idle resources");

  const result = {
    ec2: [] as Ec2IdleResource[],
    rds: [] as RdsIdleResource[],
    ebs: [] as EbsIdleResource[],
  };

  try {
    if (input.resource_type === "all" || input.resource_type === "ec2") {
      result.ec2 = await findIdleEc2InRegion(regionLog, region, input.min_idle_days);
    }
    if (input.resource_type === "all" || input.resource_type === "rds") {
      result.rds = await findIdleRdsInRegion(regionLog, region, input.min_idle_days);
    }
    if (input.resource_type === "all" || input.resource_type === "ebs") {
      result.ebs = await findUnattachedEbsInRegion(regionLog, region, input.min_idle_days);
    }

    regionLog.info("Region scan complete", {
      duration_ms: Date.now() - startMs,
      ec2_idle: result.ec2.length,
      rds_idle: result.rds.length,
      ebs_idle: result.ebs.length,
    });
  } catch (error) {
    regionLog.warn("Region scan failed — continuing with other regions", {
      duration_ms: Date.now() - startMs,
      error: serializeError(error),
    });
  }

  return result;
}

function buildActionRequired(
  resourceCount: number,
  ec2Count: number,
  rdsCount: number,
  ebsCount: number,
  ec2MonthlySavings?: string,
  rdsMonthlySavings?: string,
  ebsMonthlySavings?: string
): string {
  if (resourceCount === 0) {
    return "No idle resources found above the specified threshold.";
  }

  const savingsParts: string[] = [];

  if (ec2Count > 0 && ec2MonthlySavings) {
    savingsParts.push(`${ec2Count} idle EC2 instance(s) could save ${ec2MonthlySavings}/month if stopped or terminated`);
  }
  if (rdsCount > 0 && rdsMonthlySavings) {
    savingsParts.push(`${rdsCount} idle RDS instance(s) could save ${rdsMonthlySavings}/month if stopped or terminated`);
  }
  if (ebsCount > 0 && ebsMonthlySavings) {
    savingsParts.push(`${ebsCount} unattached EBS volume(s) could save ${ebsMonthlySavings}/month if deleted`);
  }

  if (savingsParts.length > 0) {
    return `You have ${resourceCount} idle resources. ${savingsParts.join("; ")}.`;
  }

  return `You have ${resourceCount} idle resources above the threshold. Review and remediate to reduce waste.`;
}

export async function getIdleResources(input: IdleResourcesInput) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requestLog = log.child({ request_id: requestId });
  const overallStartMs = Date.now();

  requestLog.info("getIdleResources invoked", {
    input: {
      resource_type: input.resource_type,
      min_idle_days: input.min_idle_days,
    },
    thresholds: {
      ec2_cpu_percent: CPU_IDLE_THRESHOLD,
      rds_connections: RDS_CONNECTION_IDLE_THRESHOLD,
    },
    credential_context: getAwsCredentialContext(),
  });

  try {
    const regions = await getEnabledRegions(requestLog);
    const allEc2: Ec2IdleResource[] = [];
    const allRds: RdsIdleResource[] = [];
    const allEbs: EbsIdleResource[] = [];

    const batchSize = 5;
    for (let i = 0; i < regions.length; i += batchSize) {
      const batch = regions.slice(i, i + batchSize);
      requestLog.info("Scanning region batch", {
        batch_number: Math.floor(i / batchSize) + 1,
        regions: batch,
      });

      const batchResults = await Promise.all(
        batch.map((region) => scanRegion(requestLog, region, input))
      );

      for (const result of batchResults) {
        allEc2.push(...result.ec2);
        allRds.push(...result.rds);
        allEbs.push(...result.ebs);
      }
    }

    let ec2Instances = allEc2;
    let rdsInstances = allRds;
    let ebsVolumes = allEbs;
    let ec2SavingsSummary: Record<string, unknown> = {};
    let rdsSavingsSummary: Record<string, unknown> = {};
    let ebsSavingsSummary: Record<string, unknown> = {};

    if (allEc2.length > 0) {
      const costStartMs = Date.now();
      const resourceIds = allEc2.map((i) => i.instance_id);
      const costByResource = await fetchResourceCosts(requestLog, resourceIds, EC2_COMPUTE_SERVICE, "EC2");
      const { instances, totalMonthlySavings } = enrichWithCosts(
        requestLog,
        allEc2,
        costByResource,
        "EC2",
        "EC2 compute",
        (r) => [r.instance_id, r.name],
        "Stopping or terminating"
      );

      ec2Instances = instances;
      ec2SavingsSummary = {
        ec2_cost_period: `last ${COST_LOOKBACK_DAYS} days`,
        ec2_cost_source: `AWS Cost Explorer (UnblendedCost, ${EC2_COMPUTE_SERVICE}, by RESOURCE_ID)`,
        ec2_potential_monthly_savings: formatCost(totalMonthlySavings),
        ec2_potential_annual_savings: formatCost(totalMonthlySavings * 12),
        ec2_instances_with_cost_data: instances.filter((i) => !i.cost_unavailable).length,
        ec2_instances_without_cost_data: instances.filter((i) => i.cost_unavailable).length,
      };

      requestLog.info("EC2 savings calculated", {
        duration_ms: Date.now() - costStartMs,
        ...ec2SavingsSummary,
      });
    }

    if (allRds.length > 0) {
      const costStartMs = Date.now();
      const resourceIds = allRds.map((i) => i.instance_id);
      const costByResource = await fetchResourceCosts(requestLog, resourceIds, RDS_SERVICE, "RDS");
      const { instances, totalMonthlySavings } = enrichWithCosts(
        requestLog,
        allRds,
        costByResource,
        "RDS",
        "RDS",
        (r) => [r.instance_id, r.name],
        "Stopping or terminating"
      );

      rdsInstances = instances;
      rdsSavingsSummary = {
        rds_cost_period: `last ${COST_LOOKBACK_DAYS} days`,
        rds_cost_source: `AWS Cost Explorer (UnblendedCost, ${RDS_SERVICE}, by RESOURCE_ID)`,
        rds_potential_monthly_savings: formatCost(totalMonthlySavings),
        rds_potential_annual_savings: formatCost(totalMonthlySavings * 12),
        rds_instances_with_cost_data: instances.filter((i) => !i.cost_unavailable).length,
        rds_instances_without_cost_data: instances.filter((i) => i.cost_unavailable).length,
      };

      requestLog.info("RDS savings calculated", {
        duration_ms: Date.now() - costStartMs,
        ...rdsSavingsSummary,
      });
    }

    if (allEbs.length > 0) {
      const costStartMs = Date.now();
      const resourceIds = allEbs.map((v) => v.volume_id);
      const costByResource = await fetchResourceCosts(requestLog, resourceIds, EBS_SERVICE, "EBS");
      const { instances, totalMonthlySavings } = enrichWithCosts(
        requestLog,
        allEbs,
        costByResource,
        "EBS",
        "EBS storage",
        (v) => [v.volume_id],
        "Deleting the volume"
      );

      ebsVolumes = instances;
      ebsSavingsSummary = {
        ebs_cost_period: `last ${COST_LOOKBACK_DAYS} days`,
        ebs_cost_source: `AWS Cost Explorer (UnblendedCost, ${EBS_SERVICE}, by RESOURCE_ID)`,
        ebs_potential_monthly_savings: formatCost(totalMonthlySavings),
        ebs_potential_annual_savings: formatCost(totalMonthlySavings * 12),
        ebs_volumes_with_cost_data: instances.filter((v) => !v.cost_unavailable).length,
        ebs_volumes_without_cost_data: instances.filter((v) => v.cost_unavailable).length,
      };

      requestLog.info("EBS savings calculated", {
        duration_ms: Date.now() - costStartMs,
        ...ebsSavingsSummary,
      });
    }

    const results: Record<string, unknown[]> = {};

    if (ec2Instances.length > 0) results.ec2_instances = ec2Instances;
    if (rdsInstances.length > 0) results.rds_instances = rdsInstances;
    if (ebsVolumes.length > 0) results.ebs_volumes = ebsVolumes;

    const resourceCount =
      ec2Instances.length + rdsInstances.length + ebsVolumes.length;

    requestLog.info("getIdleResources completed successfully", {
      duration_ms: Date.now() - overallStartMs,
      regions_scanned: regions.length,
      idle_resources_found: resourceCount,
      ec2_count: ec2Instances.length,
      rds_count: rdsInstances.length,
      ebs_count: ebsVolumes.length,
    });

    const actionRequired = buildActionRequired(
      resourceCount,
      ec2Instances.length,
      rdsInstances.length,
      ebsVolumes.length,
      ec2SavingsSummary.ec2_potential_monthly_savings as string | undefined,
      rdsSavingsSummary.rds_potential_monthly_savings as string | undefined,
      ebsSavingsSummary.ebs_potential_monthly_savings as string | undefined
    );

    return {
      idle_resources_found: resourceCount,
      regions_scanned: regions.length,
      min_idle_days: input.min_idle_days,
      ...ec2SavingsSummary,
      ...rdsSavingsSummary,
      ...ebsSavingsSummary,
      ...results,
      action_required: actionRequired,
    };
  } catch (error) {
    requestLog.error("getIdleResources failed", {
      duration_ms: Date.now() - overallStartMs,
      error: serializeError(error),
      credential_context: getAwsCredentialContext(),
    });

    return {
      error: true,
      message: `Failed to scan for idle resources: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure AWS credentials are configured with ec2:DescribeInstances, ec2:DescribeVolumes, ec2:DescribeRegions, rds:DescribeDBInstances, cloudwatch:GetMetricStatistics, and ce:GetCostAndUsage permissions.",
    };
  }
}
