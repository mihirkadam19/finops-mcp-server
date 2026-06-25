import { z } from "zod";
import { InstancesClient, DisksClient } from "@google-cloud/compute";
import { MetricServiceClient } from "@google-cloud/monitoring";
import { GoogleAuth, Impersonated } from "google-auth-library";
import type { GcpCredentials } from "./gcpCostSummary.js";
import { createLogger, serializeError } from "../../utils/fileLogger.js";

const log = createLogger("gcpIdleResources");
log.info("gcpIdleResources module loaded");

export const gcpIdleResourcesSchema = z.object({
  resource_type: z.enum(["all", "compute", "disk"]).default("all"),
  min_idle_days: z.number().default(7),
  cpu_threshold_percent: z.number().default(5),
});

export type GcpIdleResourcesInput = z.infer<typeof gcpIdleResourcesSchema>;

// Builds auth options accepted by all GCP gapic clients
async function buildAuthOptions(credentials: GcpCredentials): Promise<Record<string, unknown>> {
  if (credentials.clientEmail && credentials.privateKey) {
    return {
      credentials: {
        client_email: credentials.clientEmail,
        private_key: credentials.privateKey.replace(/\\n/g, "\n"),
      },
    };
  }

  if (credentials.impersonateServiceAccount) {
    const sourceAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const sourceClient = await sourceAuth.getClient();
    const impersonated = new Impersonated({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sourceClient: sourceClient as any,
      targetPrincipal: credentials.impersonateServiceAccount,
      lifetime: 3600,
      delegates: [],
      targetScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const auth = new GoogleAuth({ projectId: credentials.projectId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (auth as any).cachedCredential = impersonated;
    return { auth };
  }

  return {}; // ADC fallback
}

function extractZoneName(zoneUrlOrKey: string): string {
  // Handles both "zones/us-central1-a" and full URLs
  return zoneUrlOrKey.split("/").pop() ?? zoneUrlOrKey;
}

function extractResourceName(urlOrName: string): string {
  return urlOrName.split("/").pop() ?? urlOrName;
}

async function findIdleVMs(
  requestLog: ReturnType<typeof log.child>,
  project: string,
  authOptions: Record<string, unknown>,
  minIdleDays: number,
  cpuThresholdPercent: number
) {
  const instancesClient = new InstancesClient({ projectId: project, ...authOptions });
  const monitoringClient = new MetricServiceClient({ projectId: project, ...authOptions });

  // 1. Collect all running VMs across all zones
  const runningVMs: {
    id: string;
    name: string;
    zone: string;
    machineType: string;
  }[] = [];

  requestLog.info("Listing running Compute Engine instances");

  for await (const [zoneKey, scopedList] of instancesClient.aggregatedListAsync({
    project,
    filter: 'status = "RUNNING"',
  })) {
    for (const instance of scopedList.instances ?? []) {
      if (!instance.id || !instance.name) continue;
      runningVMs.push({
        id: instance.id.toString(),
        name: instance.name,
        zone: extractZoneName(zoneKey),
        machineType: extractResourceName(instance.machineType ?? "unknown"),
      });
    }
  }

  requestLog.info("Running VMs listed", { count: runningVMs.length });

  if (runningVMs.length === 0) return { idleVMs: [], vmsScanned: 0 };

  // 2. Fetch CPU utilization for all instances in one Monitoring API call
  const endTime = new Date();
  const startTime = new Date();
  startTime.setDate(endTime.getDate() - minIdleDays);

  const cpuByInstanceId = new Map<string, number>();

  requestLog.info("Fetching CPU metrics from Cloud Monitoring", {
    start: startTime.toISOString(),
    end: endTime.toISOString(),
  });

  for await (const series of monitoringClient.listTimeSeriesAsync({
    name: `projects/${project}`,
    filter: 'metric.type="compute.googleapis.com/instance/cpu/utilization"',
    interval: {
      startTime: { seconds: Math.floor(startTime.getTime() / 1000) },
      endTime: { seconds: Math.floor(endTime.getTime() / 1000) },
    },
    aggregation: {
      alignmentPeriod: { seconds: 86400 }, // daily buckets
      perSeriesAligner: "ALIGN_MEAN",
      crossSeriesReducer: "REDUCE_MEAN",
      groupByFields: ["resource.labels.instance_id"],
    },
    view: "FULL",
  })) {
    const instanceId = series.resource?.labels?.["instance_id"];
    if (!instanceId) continue;

    const values = (series.points ?? [])
      .map((p) => p.value?.doubleValue ?? 0);

    if (values.length > 0) {
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
      cpuByInstanceId.set(instanceId, avg * 100); // 0-1 → percentage
    }
  }

  requestLog.info("CPU metrics fetched", {
    instances_with_metrics: cpuByInstanceId.size,
    instances_without_metrics: runningVMs.length - cpuByInstanceId.size,
  });

  // 3. Flag VMs below CPU threshold
  const idleVMs: {
    instance_id: string;
    name: string;
    machine_type: string;
    zone: string;
    avg_cpu_percent: string;
    recommendation: string;
  }[] = [];

  for (const vm of runningVMs) {
    const avgCpu = cpuByInstanceId.get(vm.id);
    if (avgCpu === undefined) continue; // no metric data yet, skip
    if (avgCpu >= cpuThresholdPercent) continue;

    idleVMs.push({
      instance_id: vm.id,
      name: vm.name,
      machine_type: vm.machineType,
      zone: vm.zone,
      avg_cpu_percent: `${avgCpu.toFixed(2)}%`,
      recommendation: `Average CPU ${avgCpu.toFixed(2)}% over ${minIdleDays} days is below the ${cpuThresholdPercent}% threshold. Consider stopping or rightsizing.`,
    });
  }

  requestLog.info("Idle VM detection complete", {
    vms_scanned: runningVMs.length,
    idle_found: idleVMs.length,
  });

  return { idleVMs, vmsScanned: runningVMs.length };
}

async function findUnattachedDisks(
  requestLog: ReturnType<typeof log.child>,
  project: string,
  authOptions: Record<string, unknown>
) {
  const disksClient = new DisksClient({ projectId: project, ...authOptions });

  requestLog.info("Listing unattached persistent disks");

  const unattachedDisks: {
    disk_name: string;
    zone: string;
    size_gb: string;
    disk_type: string;
    created: string;
    recommendation: string;
  }[] = [];

  let disksScanned = 0;

  for await (const [zoneKey, scopedList] of disksClient.aggregatedListAsync({ project })) {
    for (const disk of scopedList.disks ?? []) {
      disksScanned++;
      if (disk.users && disk.users.length > 0) continue; // attached, skip

      unattachedDisks.push({
        disk_name: disk.name ?? "Unknown",
        zone: extractZoneName(zoneKey),
        size_gb: `${disk.sizeGb ?? 0} GB`,
        disk_type: extractResourceName(disk.type ?? "unknown"),
        created: disk.creationTimestamp ?? "unknown",
        recommendation: `Persistent disk is not attached to any VM. Delete or snapshot it to eliminate storage charges.`,
      });
    }
  }

  requestLog.info("Disk scan complete", {
    disks_scanned: disksScanned,
    unattached_found: unattachedDisks.length,
  });

  return { unattachedDisks, disksScanned };
}

export async function getGcpIdleResources(
  input: GcpIdleResourcesInput,
  credentials: GcpCredentials
) {
  const requestLog = log.child({
    request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });
  const startMs = Date.now();

  requestLog.info("getGcpIdleResources invoked", { input });

  try {
    const authOptions = await buildAuthOptions(credentials);
    const project = credentials.projectId;

    let idleVMs: Awaited<ReturnType<typeof findIdleVMs>>["idleVMs"] = [];
    let vmsScanned = 0;
    let unattachedDisks: Awaited<ReturnType<typeof findUnattachedDisks>>["unattachedDisks"] = [];
    let disksScanned = 0;

    if (input.resource_type === "all" || input.resource_type === "compute") {
      const vmResult = await findIdleVMs(
        requestLog, project, authOptions, input.min_idle_days, input.cpu_threshold_percent
      );
      idleVMs = vmResult.idleVMs;
      vmsScanned = vmResult.vmsScanned;
    }

    if (input.resource_type === "all" || input.resource_type === "disk") {
      const diskResult = await findUnattachedDisks(requestLog, project, authOptions);
      unattachedDisks = diskResult.unattachedDisks;
      disksScanned = diskResult.disksScanned;
    }

    const totalIdle = idleVMs.length + unattachedDisks.length;

    requestLog.info("getGcpIdleResources completed", {
      duration_ms: Date.now() - startMs,
      idle_resources_found: totalIdle,
    });

    const result: Record<string, unknown> = {
      idle_resources_found: totalIdle,
      project_id: project,
      min_idle_days: input.min_idle_days,
      cpu_threshold_percent: input.cpu_threshold_percent,
    };

    if (input.resource_type !== "disk") {
      result.vms_scanned = vmsScanned;
      result.idle_vms = idleVMs;
    }

    if (input.resource_type !== "compute") {
      result.disks_scanned = disksScanned;
      result.unattached_disks = unattachedDisks;
    }

    result.action_required =
      totalIdle > 0
        ? `Found ${idleVMs.length} idle VM(s) and ${unattachedDisks.length} unattached disk(s). Review for cost savings.`
        : "No idle resources found above the specified threshold.";

    return result;
  } catch (error) {
    requestLog.error("getGcpIdleResources failed", {
      duration_ms: Date.now() - startMs,
      error: serializeError(error),
    });

    return {
      error: true,
      message: `Failed to scan GCP idle resources: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure your credentials have roles/compute.viewer and roles/monitoring.viewer on the project.",
    };
  }
}
