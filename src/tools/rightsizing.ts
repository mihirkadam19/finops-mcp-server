import { z } from "zod";
import { mockRightsizing } from "../data/mockData.js";

export const rightsizingSchema = z.object({
  min_monthly_savings: z.number().default(50),
  confidence: z.enum(["all", "High", "Medium"]).default("all"),
});

export type RightsizingInput = z.infer<typeof rightsizingSchema>;

export function getRightsizingRecommendations(input: RightsizingInput) {
  let recommendations = mockRightsizing.filter(
    (r) => r.monthly_savings >= input.min_monthly_savings
  );

  if (input.confidence !== "all") {
    recommendations = recommendations.filter(
      (r) => r.confidence === input.confidence
    );
  }

  if (recommendations.length === 0) {
    return {
      recommendations_found: 0,
      message: "No rightsizing opportunities found matching the specified criteria.",
    };
  }

  const totalMonthlySavings = recommendations.reduce(
    (sum, r) => sum + r.monthly_savings, 0
  );

  return {
    recommendations_found: recommendations.length,
    total_monthly_savings: `$${totalMonthlySavings.toFixed(2)}`,
    total_annual_savings: `$${(totalMonthlySavings * 12).toFixed(2)}`,
    recommendations: recommendations.map((r) => ({
      instance_id: r.instance_id,
      name: r.name,
      region: r.region,
      current_instance: r.current_type,
      current_cost: `$${r.current_monthly_cost.toFixed(2)}/month`,
      recommended_instance: r.recommended_type,
      recommended_cost: `$${r.recommended_monthly_cost.toFixed(2)}/month`,
      monthly_savings: `$${r.monthly_savings.toFixed(2)}`,
      avg_cpu_utilization: `${r.avg_cpu}%`,
      avg_memory_utilization: `${r.avg_memory}%`,
      confidence: r.confidence,
      reason: r.reason,
    })),
    summary: `Downsizing ${recommendations.length} over-provisioned instances would save $${totalMonthlySavings.toFixed(2)}/month ($${(totalMonthlySavings * 12).toFixed(2)}/year) with no impact on performance.`,
  };
}
