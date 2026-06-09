import { z } from "zod";
import { mockCostData } from "../data/mockData.js";

export const costSummarySchema = z.object({
  period: z.enum(["last_7_days", "last_30_days", "last_3_months"]).default("last_30_days"),
  group_by: z.enum(["service", "region", "both"]).default("both"),
});

export type CostSummaryInput = z.infer<typeof costSummarySchema>;

export function getCostSummary(input: CostSummaryInput) {
  const data = mockCostData.summary[input.period];

  const result: Record<string, unknown> = {
    period: input.period,
    total_cost: `$${data.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    currency: "USD",
  };

  if (input.group_by === "service" || input.group_by === "both") {
    result.by_service = data.by_service.map((s) => ({
      service: s.service,
      cost: `$${s.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      percentage: `${s.percentage}%`,
    }));
  }

  if (input.group_by === "region" || input.group_by === "both") {
    result.by_region = data.by_region.map((r) => ({
      region: r.region,
      cost: `$${r.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    }));
  }

  result.insight = `Your top spending service is ${data.by_service[0]?.service} at ${data.by_service[0]?.percentage}% of total spend. Your highest cost region is ${data.by_region[0]?.region}.`;

  return result;
}
