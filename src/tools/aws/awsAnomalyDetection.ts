import { z } from "zod";
import {
  CostExplorerClient,
  GetAnomaliesCommand,
  type Anomaly,
} from "@aws-sdk/client-cost-explorer";
import { createLogger, getAwsCredentialContext, serializeError, type Logger } from "../../utils/fileLogger";

const log = createLogger("anomalyDetection");

log.info("anomalyDetection module loaded", {
  credential_context: getAwsCredentialContext(),
});

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

function createClient(credentials?: AwsCredentials): CostExplorerClient {
  if (credentials) {
    return new CostExplorerClient({
      region: credentials.region ?? "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
  }
  return new CostExplorerClient({});
}

export const anomalySchema = z.object({
  min_spike_percentage: z.number().default(50),
});

export type AnomalyInput = z.infer<typeof anomalySchema>;

interface MappedAnomaly {
  service: string;
  region: string;
  detected_date: string;
  expected_daily_cost: number;
  actual_daily_cost: number;
  spike_percentage: number;
  estimated_extra_cost: number;
  likely_cause: string;
  anomaly_id?: string;
  anomaly_start_date?: string;
  anomaly_end_date?: string;
  monitor_arn?: string;
  feedback?: string;
}

function getDateRange(requestLog: Logger): { StartDate: string; EndDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 90);

  const range = {
    StartDate: start.toISOString().split("T")[0]!,
    EndDate: end.toISOString().split("T")[0]!,
  };

  requestLog.debug("Resolving anomaly date range", {
    lookback_days: 90,
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
  });

  requestLog.info("Computed anomaly lookup date range (last 90 days)", range);
  return range;
}

function formatAmount(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function daysInAnomaly(
  requestLog: Logger,
  startDate: string | undefined,
  endDate: string | undefined,
  anomalyId?: string
): number {
  if (!startDate || !endDate) {
    requestLog.debug("Anomaly missing start/end date — defaulting to 1 day", {
      anomaly_id: anomalyId,
      start_date: startDate ?? null,
      end_date: endDate ?? null,
    });
    return 1;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffMs = end.getTime() - start.getTime();
  const days = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1);

  requestLog.debug("Computed anomaly duration", {
    anomaly_id: anomalyId,
    start_date: startDate,
    end_date: endDate,
    duration_days: days,
  });

  return days;
}

function buildLikelyCause(anomaly: Anomaly, requestLog: Logger): string {
  const rootCauses = anomaly.RootCauses ?? [];

  if (rootCauses.length === 0) {
    requestLog.debug("No root causes on anomaly — using generic likely_cause", {
      anomaly_id: anomaly.AnomalyId,
    });
    return "AWS Cost Anomaly Detection flagged unusual spending. Review the anomaly in Cost Explorer for linked resources and usage drivers.";
  }

  const primary = rootCauses[0];
  const parts = [
    primary?.Service && `service ${primary.Service}`,
    primary?.Region && `region ${primary.Region}`,
    primary?.UsageType && `usage type ${primary.UsageType}`,
    primary?.LinkedAccountName && `account ${primary.LinkedAccountName}`,
  ].filter(Boolean);

  requestLog.debug("Built likely_cause from root causes", {
    anomaly_id: anomaly.AnomalyId,
    root_cause_count: rootCauses.length,
    primary_root_cause: {
      service: primary?.Service ?? null,
      region: primary?.Region ?? null,
      usage_type: primary?.UsageType ?? null,
      linked_account: primary?.LinkedAccount ?? null,
      linked_account_name: primary?.LinkedAccountName ?? null,
    },
    additional_root_cause_count: Math.max(0, rootCauses.length - 1),
  });

  const detail = parts.length > 0 ? parts.join(", ") : "one or more linked dimensions";
  return `Unusual spend detected for ${detail}. Review recent deployments, scaling events, or configuration changes in this area.`;
}

function summarizeRawAnomaly(anomaly: Anomaly): Record<string, unknown> {
  return {
    anomaly_id: anomaly.AnomalyId,
    start: anomaly.AnomalyStartDate,
    end: anomaly.AnomalyEndDate,
    monitor_arn: anomaly.MonitorArn,
    feedback: anomaly.Feedback ?? null,
    impact: {
      total_impact: anomaly.Impact?.TotalImpact,
      total_impact_percentage: anomaly.Impact?.TotalImpactPercentage,
      total_expected_spend: anomaly.Impact?.TotalExpectedSpend,
      total_actual_spend: anomaly.Impact?.TotalActualSpend,
      max_impact: anomaly.Impact?.MaxImpact,
    },
    root_cause_count: anomaly.RootCauses?.length ?? 0,
    root_causes: anomaly.RootCauses?.map((rc) => ({
      service: rc.Service,
      region: rc.Region,
      usage_type: rc.UsageType,
      linked_account: rc.LinkedAccount,
      linked_account_name: rc.LinkedAccountName,
    })),
  };
}

function mapAnomaly(anomaly: Anomaly, requestLog: Logger): MappedAnomaly {
  const impact = anomaly.Impact;
  const rootCause = anomaly.RootCauses?.[0];
  const days = daysInAnomaly(
    requestLog,
    anomaly.AnomalyStartDate,
    anomaly.AnomalyEndDate,
    anomaly.AnomalyId
  );

  const totalExpected = impact?.TotalExpectedSpend ?? 0;
  const totalActual = impact?.TotalActualSpend ?? 0;
  const totalImpact = impact?.TotalImpact ?? 0;
  const spikePercentage = impact?.TotalImpactPercentage ?? 0;

  const mapped: MappedAnomaly = {
    anomaly_id: anomaly.AnomalyId,
    anomaly_start_date: anomaly.AnomalyStartDate,
    anomaly_end_date: anomaly.AnomalyEndDate,
    monitor_arn: anomaly.MonitorArn,
    feedback: anomaly.Feedback,
    service: rootCause?.Service ?? "Unknown",
    region: rootCause?.Region ?? "Global",
    detected_date: anomaly.AnomalyEndDate ?? anomaly.AnomalyStartDate ?? "Unknown",
    expected_daily_cost: totalExpected / days,
    actual_daily_cost: totalActual / days,
    spike_percentage: spikePercentage,
    estimated_extra_cost: totalImpact,
    likely_cause: buildLikelyCause(anomaly, requestLog),
  };

  requestLog.debug("Mapped raw anomaly to output shape", {
    anomaly_id: mapped.anomaly_id,
    service: mapped.service,
    region: mapped.region,
    duration_days: days,
    spike_percentage: mapped.spike_percentage,
    estimated_extra_cost: mapped.estimated_extra_cost,
    expected_daily_cost: mapped.expected_daily_cost,
    actual_daily_cost: mapped.actual_daily_cost,
    raw_impact: impact ?? null,
  });

  return mapped;
}

async function fetchAllAnomalies(
  requestLog: Logger,
  dateInterval: { StartDate: string; EndDate: string },
  client: CostExplorerClient
): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];
  let nextPageToken: string | undefined;
  let pageNumber = 0;

  requestLog.info("Starting paginated GetAnomalies fetch", { date_interval: dateInterval });

  do {
    pageNumber += 1;
    const commandInput = {
      DateInterval: dateInterval,
      MaxResults: 100,
      ...(nextPageToken && { NextPageToken: nextPageToken }),
    };

    requestLog.info("Preparing GetAnomalies API call", {
      command: "GetAnomalies",
      page_number: pageNumber,
      input: commandInput,
    });

    requestLog.debug("Sending GetAnomalies request", { page_number: pageNumber });

    const startMs = Date.now();
    const response = await client.send(new GetAnomaliesCommand(commandInput));
    const durationMs = Date.now() - startMs;

    const page = response.Anomalies ?? [];
    anomalies.push(...page);

    requestLog.info("GetAnomalies page received", {
      page_number: pageNumber,
      duration_ms: durationMs,
      page_count: page.length,
      total_so_far: anomalies.length,
      has_next_page: Boolean(response.NextPageToken),
      response_metadata: response.$metadata ?? null,
    });

    requestLog.debug("GetAnomalies page raw anomalies", {
      page_number: pageNumber,
      anomalies: page.map(summarizeRawAnomaly),
    });

    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  requestLog.info("GetAnomalies pagination complete", {
    total_pages: pageNumber,
    total_anomalies: anomalies.length,
    unique_monitors: [...new Set(anomalies.map((a) => a.MonitorArn).filter(Boolean))].length,
    feedback_breakdown: anomalies.reduce<Record<string, number>>((acc, a) => {
      const key = a.Feedback ?? "unset";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  });

  return anomalies;
}

function logFilterResults(
  requestLog: Logger,
  mapped: MappedAnomaly[],
  filtered: MappedAnomaly[],
  minSpikePercentage: number
): void {
  const excluded = mapped.filter((a) => a.spike_percentage < minSpikePercentage);

  requestLog.info("Anomalies filtered by threshold", {
    min_spike_percentage: minSpikePercentage,
    before_filter: mapped.length,
    after_filter: filtered.length,
    excluded_count: excluded.length,
  });

  if (excluded.length > 0) {
    requestLog.debug("Anomalies excluded by threshold", {
      excluded: excluded.map((a) => ({
        anomaly_id: a.anomaly_id,
        service: a.service,
        region: a.region,
        spike_percentage: a.spike_percentage,
        estimated_extra_cost: a.estimated_extra_cost,
      })),
    });
  }

  if (filtered.length > 0) {
    requestLog.info("Top anomalies after filtering", {
      top_5: filtered.slice(0, 5).map((a) => ({
        anomaly_id: a.anomaly_id,
        service: a.service,
        region: a.region,
        spike_percentage: a.spike_percentage,
        estimated_extra_cost: a.estimated_extra_cost,
        detected_date: a.detected_date,
      })),
      unique_services: [...new Set(filtered.map((a) => a.service))],
      unique_regions: [...new Set(filtered.map((a) => a.region))],
      spike_stats: {
        min: filtered[filtered.length - 1]?.spike_percentage,
        max: filtered[0]?.spike_percentage,
        avg: filtered.reduce((sum, a) => sum + a.spike_percentage, 0) / filtered.length,
      },
    });
  }
}

export async function detectAnomalies(input: AnomalyInput, credentials?: AwsCredentials) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requestLog = log.child({ request_id: requestId });
  const overallStartMs = Date.now();
  const client = createClient(credentials);

  requestLog.info("detectAnomalies invoked", {
    input: { min_spike_percentage: input.min_spike_percentage },
    credential_source: credentials ? "explicit" : "env/default",
    credential_context: getAwsCredentialContext(),
  });

  try {
    const dateInterval = getDateRange(requestLog);

    const fetchStartMs = Date.now();
    const rawAnomalies = await fetchAllAnomalies(requestLog, dateInterval, client);
    const fetchDurationMs = Date.now() - fetchStartMs;

    requestLog.info("Raw anomalies fetched", {
      count: rawAnomalies.length,
      fetch_duration_ms: fetchDurationMs,
      date_interval: dateInterval,
    });

    if (rawAnomalies.length === 0) {
      requestLog.warn("AWS returned zero anomalies for date range", {
        date_interval: dateInterval,
        hint: "Cost Anomaly Detection may not be enabled or no anomalies occurred in this window",
      });
    }

    const mapStartMs = Date.now();
    const mapped = rawAnomalies.map((anomaly) => mapAnomaly(anomaly, requestLog));
    const mapDurationMs = Date.now() - mapStartMs;

    requestLog.info("Anomaly mapping complete", {
      mapped_count: mapped.length,
      map_duration_ms: mapDurationMs,
    });

    const filterStartMs = Date.now();
    const filtered = mapped
      .filter((a) => a.spike_percentage >= input.min_spike_percentage)
      .sort((a, b) => b.spike_percentage - a.spike_percentage);
    const filterDurationMs = Date.now() - filterStartMs;

    logFilterResults(requestLog, mapped, filtered, input.min_spike_percentage);

    requestLog.debug("Filter/sort phase timing", { filter_duration_ms: filterDurationMs });

    if (filtered.length === 0) {
      requestLog.warn("No anomalies above threshold", {
        min_spike_percentage: input.min_spike_percentage,
        raw_anomaly_count: rawAnomalies.length,
        below_threshold_count: mapped.length,
        duration_ms: Date.now() - overallStartMs,
        ...(mapped.length > 0 && {
          highest_spike_below_threshold: mapped
            .sort((a, b) => b.spike_percentage - a.spike_percentage)[0],
        }),
      });

      return {
        anomalies_found: 0,
        date_range: `${dateInterval.StartDate} to ${dateInterval.EndDate}`,
        min_spike_percentage: input.min_spike_percentage,
        message: rawAnomalies.length === 0
          ? "No cost anomalies detected in the last 90 days. Ensure Cost Anomaly Detection is enabled in your AWS account."
          : "No cost anomalies detected above the specified threshold.",
      };
    }

    const totalExtraCost = filtered.reduce((sum, a) => sum + a.estimated_extra_cost, 0);
    const mostSevere = filtered[0]!;

    const result = {
      anomalies_found: filtered.length,
      date_range: `${dateInterval.StartDate} to ${dateInterval.EndDate}`,
      min_spike_percentage: input.min_spike_percentage,
      total_extra_cost: formatAmount(totalExtraCost),
      anomalies: filtered.map((a) => ({
        service: a.service,
        region: a.region,
        detected_date: a.detected_date,
        expected_daily_cost: formatAmount(a.expected_daily_cost),
        actual_daily_cost: formatAmount(a.actual_daily_cost),
        spike: `+${a.spike_percentage.toFixed(1)}%`,
        estimated_extra_cost: formatAmount(a.estimated_extra_cost),
        likely_cause: a.likely_cause,
        anomaly_id: a.anomaly_id,
        anomaly_start_date: a.anomaly_start_date,
        anomaly_end_date: a.anomaly_end_date,
        monitor_arn: a.monitor_arn,
        feedback: a.feedback,
      })),
      summary: `Found ${filtered.length} anomalies totaling ${formatAmount(totalExtraCost)} in unexpected charges. Most severe: ${mostSevere.service} in ${mostSevere.region} spiked ${mostSevere.spike_percentage.toFixed(1)}%.`,
    };

    requestLog.info("detectAnomalies completed successfully", {
      duration_ms: Date.now() - overallStartMs,
      phase_timing_ms: {
        fetch: fetchDurationMs,
        map: mapDurationMs,
        filter: filterDurationMs,
      },
      anomalies_found: filtered.length,
      total_extra_cost: totalExtraCost,
      most_severe: {
        anomaly_id: mostSevere.anomaly_id,
        service: mostSevere.service,
        region: mostSevere.region,
        spike_percentage: mostSevere.spike_percentage,
      },
    });

    requestLog.debug("Final anomaly detection result", { result });

    return result;
  } catch (error) {
    requestLog.error("detectAnomalies failed", {
      duration_ms: Date.now() - overallStartMs,
      error: serializeError(error),
      credential_context: getAwsCredentialContext(),
    });

    return {
      error: true,
      message: `Failed to fetch cost anomalies: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure AWS credentials are configured, Cost Explorer is enabled, and Cost Anomaly Detection monitors are set up in your account.",
    };
  }
}