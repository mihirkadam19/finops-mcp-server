import { z } from "zod";
import { BigQuery } from "@google-cloud/bigquery";
import { GoogleAuth, Impersonated } from "google-auth-library";
import type { GcpCredentials } from "./gcpCostSummary.js";
import { createLogger, serializeError } from "../../utils/fileLogger.js";

const log = createLogger("gcpAnomalyDetection");
log.info("gcpAnomalyDetection module loaded");

export const gcpAnomalySchema = z.object({
  lookback_days: z.number().default(30).describe("Days of daily cost history to analyze"),
  min_spike_percentage: z.number().default(50).describe("Minimum % above average daily cost to flag as an anomaly"),
});

export type GcpAnomalyInput = z.infer<typeof gcpAnomalySchema>;

const NET_COST_EXPR = `SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0))`;

function formatAmount(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

async function createClient(credentials: GcpCredentials): Promise<BigQuery> {
  if (credentials.clientEmail && credentials.privateKey) {
    return new BigQuery({
      projectId: credentials.projectId,
      credentials: {
        client_email: credentials.clientEmail,
        private_key: credentials.privateKey.replace(/\\n/g, "\n"),
      },
    });
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
    const bq = new BigQuery({ projectId: credentials.projectId });
    (bq as unknown as { auth: { cachedCredential: unknown } }).auth.cachedCredential = impersonated;
    return bq;
  }

  return new BigQuery({ projectId: credentials.projectId });
}

export async function detectGcpAnomalies(
  input: GcpAnomalyInput,
  credentials: GcpCredentials
) {
  const requestLog = log.child({
    request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });
  const startMs = Date.now();

  requestLog.info("detectGcpAnomalies invoked", { input });

  try {
    const client = await createClient(credentials);
    const datasetProject = credentials.datasetProjectId ?? credentials.projectId;
    const tableRef = `\`${datasetProject}.${credentials.billingDataset}.${credentials.billingTable}\``;

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - input.lookback_days);

    const startStr = startDate.toISOString().split("T")[0]!;
    const endStr = endDate.toISOString().split("T")[0]!;

    requestLog.info("Fetching daily costs from BigQuery", {
      table_ref: tableRef,
      date_range: `${startStr} to ${endStr}`,
    });

    // Step 1: Fetch daily total net cost for the lookback period
    const [dailyRows] = await client.query({
      query: `
        SELECT
          DATE(_PARTITIONTIME) AS usage_date,
          ${NET_COST_EXPR} AS net_cost
        FROM ${tableRef}
        WHERE DATE(_PARTITIONTIME) BETWEEN @start_date AND @end_date
          AND cost != 0
        GROUP BY usage_date
        ORDER BY usage_date
      `,
      params: { start_date: startStr, end_date: endStr },
      useLegacySql: false,
    });

    const dailyCosts = (dailyRows as Array<{ usage_date: { value: string } | string; net_cost: number }>).map(
      (row) => ({
        date: typeof row.usage_date === "object" ? row.usage_date.value : String(row.usage_date),
        cost: Number(row.net_cost ?? 0),
      })
    );

    requestLog.info("Daily cost data fetched", { days: dailyCosts.length });

    if (dailyCosts.length === 0) {
      return {
        anomalies_found: 0,
        date_range: `${startStr} to ${endStr}`,
        message: "No cost data found for this period. Ensure billing export is configured and the table has data.",
      };
    }

    const totalCost = dailyCosts.reduce((sum, d) => sum + d.cost, 0);
    const avgDailyCost = totalCost / dailyCosts.length;

    requestLog.info("Daily cost statistics", {
      days_with_data: dailyCosts.length,
      avg_daily_cost: avgDailyCost,
      total_cost: totalCost,
    });

    // Step 2: Identify anomaly days
    const anomalyDays = dailyCosts.filter(
      (d) => avgDailyCost > 0 && d.cost > avgDailyCost * (1 + input.min_spike_percentage / 100)
    );

    requestLog.info("Anomaly days identified", {
      threshold: `${input.min_spike_percentage}% above avg (${formatAmount(avgDailyCost)})`,
      anomaly_days_found: anomalyDays.length,
    });

    if (anomalyDays.length === 0) {
      return {
        anomalies_found: 0,
        date_range: `${startStr} to ${endStr}`,
        avg_daily_cost: formatAmount(avgDailyCost),
        min_spike_percentage: input.min_spike_percentage,
        summary: `No cost spikes above ${input.min_spike_percentage}% detected over the last ${input.lookback_days} days.`,
      };
    }

    // Step 3: Fetch per-service breakdown for anomaly days only
    const anomalyDateStrings = anomalyDays.map((d) => d.date);

    requestLog.info("Fetching service breakdown for anomaly days", {
      anomaly_dates: anomalyDateStrings,
    });

    const [serviceRows] = await client.query({
      query: `
        SELECT
          DATE(_PARTITIONTIME) AS usage_date,
          service.description AS service,
          ${NET_COST_EXPR} AS net_cost
        FROM ${tableRef}
        WHERE DATE(_PARTITIONTIME) IN UNNEST(@anomaly_dates)
          AND cost != 0
        GROUP BY usage_date, service
        HAVING ${NET_COST_EXPR} > 0
        ORDER BY usage_date, net_cost DESC
      `,
      params: { anomaly_dates: anomalyDateStrings },
      useLegacySql: false,
    });

    // Build a map of date -> top services
    const servicesByDate = new Map<string, { service: string; cost: number }[]>();
    for (const row of serviceRows as Array<{
      usage_date: { value: string } | string;
      service: string;
      net_cost: number;
    }>) {
      const date = typeof row.usage_date === "object" ? row.usage_date.value : String(row.usage_date);
      const entry = servicesByDate.get(date) ?? [];
      entry.push({ service: row.service ?? "Unknown", cost: Number(row.net_cost ?? 0) });
      servicesByDate.set(date, entry);
    }

    // Step 4: Build anomaly output
    const anomalies = anomalyDays
      .map((d) => {
        const spikePercent = ((d.cost - avgDailyCost) / avgDailyCost) * 100;
        const topServices = (servicesByDate.get(d.date) ?? []).slice(0, 3);
        return {
          date: d.date,
          actual_cost: formatAmount(d.cost),
          expected_cost: formatAmount(avgDailyCost),
          spike: `+${spikePercent.toFixed(1)}%`,
          extra_cost: formatAmount(d.cost - avgDailyCost),
          top_services: topServices.map((s) => ({
            service: s.service,
            cost: formatAmount(s.cost),
            share: d.cost > 0 ? `${((s.cost / d.cost) * 100).toFixed(1)}%` : "0%",
          })),
        };
      })
      .sort((a, b) => parseFloat(b.spike) - parseFloat(a.spike));

    const totalExtraCost = anomalies.reduce(
      (sum, a) => sum + parseFloat(a.extra_cost.replace("$", "")),
      0
    );

    const mostSevere = anomalies[0]!;

    requestLog.info("detectGcpAnomalies completed", {
      duration_ms: Date.now() - startMs,
      anomalies_found: anomalies.length,
      total_extra_cost: totalExtraCost,
    });

    return {
      anomalies_found: anomalies.length,
      date_range: `${startStr} to ${endStr}`,
      avg_daily_cost: formatAmount(avgDailyCost),
      min_spike_percentage: input.min_spike_percentage,
      total_extra_cost: formatAmount(totalExtraCost),
      anomalies,
      summary: `Found ${anomalies.length} day(s) with cost spikes above ${input.min_spike_percentage}%, totaling ${formatAmount(totalExtraCost)} in extra spend. Most severe: ${mostSevere.date} at ${mostSevere.spike}.`,
    };
  } catch (error) {
    requestLog.error("detectGcpAnomalies failed", {
      duration_ms: Date.now() - startMs,
      error: serializeError(error),
    });

    return {
      error: true,
      message: `Failed to detect GCP cost anomalies: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure BigQuery billing export is configured, the table exists, and your credentials have BigQuery Data Viewer role.",
    };
  }
}
