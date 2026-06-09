import { z } from "zod";
import { mockAnomalies } from "../data/mockData.js";

export const anomalySchema = z.object({
  min_spike_percentage: z.number().default(50),
});

export type AnomalyInput = z.infer<typeof anomalySchema>;

export function detectAnomalies(input: AnomalyInput) {
  const filtered = mockAnomalies.filter(
    (a) => a.spike_percentage >= input.min_spike_percentage
  );

  if (filtered.length === 0) {
    return {
      anomalies_found: 0,
      message: "No cost anomalies detected above the specified threshold.",
    };
  }

  const totalExtraCost = filtered.reduce((sum, a) => sum + a.estimated_extra_cost, 0);

  return {
    anomalies_found: filtered.length,
    total_extra_cost: `$${totalExtraCost.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    anomalies: filtered.map((a) => ({
      service: a.service,
      region: a.region,
      detected_date: a.detected_date,
      expected_daily_cost: `$${a.expected_daily_cost.toFixed(2)}`,
      actual_daily_cost: `$${a.actual_daily_cost.toFixed(2)}`,
      spike: `+${a.spike_percentage.toFixed(1)}%`,
      estimated_extra_cost: `$${a.estimated_extra_cost.toFixed(2)}`,
      likely_cause: a.likely_cause,
    })),
    summary: `Found ${filtered.length} anomalies totaling $${totalExtraCost.toFixed(2)} in unexpected charges. Most severe: ${filtered[0]?.service} in ${filtered[0]?.region} spiked ${filtered[0]?.spike_percentage.toFixed(1)}%.`,
  };
}
