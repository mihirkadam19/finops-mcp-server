import { z } from "zod";
import { ClientSecretCredential } from "@azure/identity";
import { CostManagementClient } from "@azure/arm-costmanagement";
import { createLogger, serializeError } from "../../utils/fileLogger.js";

const log = createLogger("azureCostSummary");

log.info("azureCostSummary module loaded");

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

function createClient(credentials: AzureCredentials): CostManagementClient {
  const credential = new ClientSecretCredential(
    credentials.tenantId,
    credentials.clientId,
    credentials.clientSecret
  );
  return new CostManagementClient(credential);
}

export const azureCostSummarySchema = z.object({
  period: z.enum(["last_7_days", "last_30_days", "last_3_months"]).default("last_30_days"),
  group_by: z.enum(["service", "resource_group", "both"]).default("both"),
});

export type AzureCostSummaryInput = z.infer<typeof azureCostSummarySchema>;

function getDateRange(period: string): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();

  if (period === "last_7_days") from.setDate(to.getDate() - 7);
  else if (period === "last_3_months") from.setMonth(to.getMonth() - 3);
  else from.setDate(to.getDate() - 30);

  return { from, to };
}

function formatAmount(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function getAzureCostSummary(
  input: AzureCostSummaryInput,
  credentials: AzureCredentials
) {
  const requestLog = log.child({ request_id: `req_${Date.now()}` });
  const startMs = Date.now();

  requestLog.info("getAzureCostSummary invoked", { input });

  try {
    const client = createClient(credentials);
    const { from, to } = getDateRange(input.period);

    const scope = `/subscriptions/${credentials.subscriptionId}`;

    const result: Record<string, unknown> = {
      period: input.period,
      date_range: `${from.toISOString().split("T")[0]} to ${to.toISOString().split("T")[0]}`,
      currency: "USD",
    };

    if (input.group_by === "service" || input.group_by === "both") {
      const response = await client.query.usage(scope, {
        type: "ActualCost",
        timeframe: "Custom",
        timePeriod: { from, to },
        dataset: {
          granularity: "None",
          aggregation: {
            totalCost: { name: "Cost", function: "Sum" },
          },
          grouping: [{ type: "Dimension", name: "ServiceName" }],
        },
      });

      const rows = response.rows ?? [];
      let total = 0;
      const services: { service: string; cost: number }[] = [];

      for (const row of rows) {
        const cost = Number(row[0] ?? 0);
        const service = String(row[1] ?? "Unknown");
        total += cost;
        services.push({ service, cost });
      }

      services.sort((a, b) => b.cost - a.cost);

      result.total_cost = formatAmount(total);
      result.by_service = services.map((s) => ({
        service: s.service,
        cost: formatAmount(s.cost),
        percentage: total > 0 ? `${((s.cost / total) * 100).toFixed(1)}%` : "0%",
      }));

      if (services.length > 0) {
        result.insight = `Top spending service: ${services[0]!.service} at ${((services[0]!.cost / total) * 100).toFixed(1)}% of total spend.`;
      } else {
        result.note = "No cost data found for this period.";
      }
    }

    if (input.group_by === "resource_group" || input.group_by === "both") {
      const response = await client.query.usage(scope, {
        type: "ActualCost",
        timeframe: "Custom",
        timePeriod: { from, to },
        dataset: {
          granularity: "None",
          aggregation: {
            totalCost: { name: "Cost", function: "Sum" },
          },
          grouping: [{ type: "Dimension", name: "ResourceGroupName" }],
        },
      });

      const rows = response.rows ?? [];
      const groups: { resourceGroup: string; cost: number }[] = [];

      for (const row of rows) {
        const cost = Number(row[0] ?? 0);
        const rg = String(row[1] ?? "Unknown");
        groups.push({ resourceGroup: rg, cost });
      }

      groups.sort((a, b) => b.cost - a.cost);

      result.by_resource_group = groups.map((g) => ({
        resource_group: g.resourceGroup,
        cost: formatAmount(g.cost),
      }));
    }

    requestLog.info("getAzureCostSummary completed", {
      duration_ms: Date.now() - startMs,
    });

    return result;
  } catch (error) {
    requestLog.error("getAzureCostSummary failed", {
      duration_ms: Date.now() - startMs,
      error: serializeError(error),
    });

    return {
      error: true,
      message: `Failed to fetch Azure cost data: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure your Azure service principal has Cost Management Reader role on the subscription.",
    };
  }
}
