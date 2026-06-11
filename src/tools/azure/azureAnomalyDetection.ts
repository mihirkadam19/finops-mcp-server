import { z } from "zod";
import { ClientSecretCredential } from "@azure/identity";
import { CostManagementClient } from "@azure/arm-costmanagement";
import type { AzureCredentials } from "./azureCostSummary";
import { createLogger, serializeError } from "../../utils/fileLogger.js";

const log = createLogger("azureAnomalyDetection");
log.info("azureAnomalyDetection module loaded");

export const azureAnomalySchema = z.object({
  lookback_days: z.number().default(30).describe("Number of days of daily cost history to analyze"),
  min_spike_percentage: z.number().default(50).describe("Minimum % above average to flag as an anomaly"),
});

export type AzureAnomalyInput = z.infer<typeof azureAnomalySchema>;

function formatAmount(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function createClient(credentials: AzureCredentials): CostManagementClient {
    const credential = new ClientSecretCredential(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );
    return new CostManagementClient(credential);
  }

export async function detectAzureAnomalies(
  input: AzureAnomalyInput,
  credentials: AzureCredentials
) {
  const requestLog = log.child({ request_id: `req_${Date.now()}` });
  const startMs = Date.now();

  requestLog.info("detectAzureAnomalies invoked", { input });

  try {
    
    const client = createClient(credentials);
    const scope = `/subscriptions/${credentials.subscriptionId}`;

    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - input.lookback_days);

    // Daily total cost, no grouping
    const dailyResponse = await client.query.usage(scope, {
      type: "ActualCost",
      timeframe: "Custom",
      timePeriod: { from, to },
      dataset: {
        granularity: "Daily",
        aggregation: {
          totalCost: { name: "Cost", function: "Sum" },
        },
      },
    });

    const columns = dailyResponse.columns ?? [];
    const dateColIdx = columns.findIndex((c) => c.name === "UsageDate");
    const costColIdx = columns.findIndex((c) => c.name === "Cost" || c.name === "PreTaxCost");

    const rows = dailyResponse.rows ?? [];
    const dailyCosts: { date: string; cost: number }[] = rows.map((row) => ({
      date: String(row[dateColIdx] ?? "unknown"),
      cost: Number(row[costColIdx] ?? 0),
    }));

    requestLog.info("Fetched daily cost data", { days: dailyCosts.length });

    if (dailyCosts.length === 0) {
      return {
        anomalies_found: 0,
        date_range: `${from.toISOString().split("T")[0]} to ${to.toISOString().split("T")[0]}`,
        message: "No cost data available for this period.",
      };
    }

    const totalCost = dailyCosts.reduce((sum, d) => sum + d.cost, 0);
    const avgDailyCost = totalCost / dailyCosts.length;

    const anomalies = dailyCosts
      .filter((d) => avgDailyCost > 0 && d.cost > avgDailyCost * (1 + input.min_spike_percentage / 100))
      .map((d) => {
        const spikePercent = ((d.cost - avgDailyCost) / avgDailyCost) * 100;
        return {
          date: d.date,
          actual_cost: formatAmount(d.cost),
          expected_cost: formatAmount(avgDailyCost),
          spike: `+${spikePercent.toFixed(1)}%`,
          extra_cost: formatAmount(d.cost - avgDailyCost),
        };
      })
      .sort((a, b) => parseFloat(b.spike) - parseFloat(a.spike));

    const totalExtraCost = anomalies.reduce(
      (sum, a) => sum + parseFloat(a.extra_cost.replace("$", "")),
      0
    );

    const result = {
      anomalies_found: anomalies.length,
      date_range: `${from.toISOString().split("T")[0]} to ${to.toISOString().split("T")[0]}`,
      avg_daily_cost: formatAmount(avgDailyCost),
      min_spike_percentage: input.min_spike_percentage,
      total_extra_cost: formatAmount(totalExtraCost),
      anomalies,
      summary:
        anomalies.length > 0
          ? `Found ${anomalies.length} day(s) with cost spikes above ${input.min_spike_percentage}%, totaling ${formatAmount(totalExtraCost)} in extra spend. Most severe: ${anomalies[0]!.date} at ${anomalies[0]!.spike}.`
          : `No cost spikes above ${input.min_spike_percentage}% detected over the last ${input.lookback_days} days.`,
    };

    requestLog.info("detectAzureAnomalies completed successfully", {
      duration_ms: Date.now() - startMs,
      anomalies_found: anomalies.length,
    });

    return result;
  } catch (error) {
    requestLog.error("detectAzureAnomalies failed", {
      duration_ms: Date.now() - startMs,
      error: serializeError(error),
    });

    return {
      error: true,
      message: `Failed to detect Azure cost anomalies: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure your Azure service principal has Cost Management Reader role and the subscription supports the Cost Management Query API.",
    };
  }
}