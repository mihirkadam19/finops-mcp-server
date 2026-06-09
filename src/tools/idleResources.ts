import { z } from "zod";
import { mockIdleResources } from "../data/mockData.js";

export const idleResourcesSchema = z.object({
  resource_type: z.enum(["all", "ec2", "rds", "ebs"]).default("all"),
  min_idle_days: z.number().default(7),
});

export type IdleResourcesInput = z.infer<typeof idleResourcesSchema>;

export function getIdleResources(input: IdleResourcesInput) {
  const results: Record<string, unknown[]> = {};
  let totalMonthlyCost = 0;

  if (input.resource_type === "all" || input.resource_type === "ec2") {
    const idleEc2 = mockIdleResources.ec2.filter(
      (r) => r.days_idle >= input.min_idle_days
    );
    if (idleEc2.length > 0) {
      results.ec2_instances = idleEc2.map((r) => ({
        instance_id: r.instance_id,
        name: r.name,
        type: r.instance_type,
        region: r.region,
        avg_cpu: `${r.avg_cpu_utilization}%`,
        days_idle: r.days_idle,
        monthly_cost: `$${r.monthly_cost.toFixed(2)}`,
        recommendation: r.recommendation,
      }));
      totalMonthlyCost += idleEc2.reduce((sum, r) => sum + r.monthly_cost, 0);
    }
  }

  if (input.resource_type === "all" || input.resource_type === "rds") {
    const idleRds = mockIdleResources.rds.filter(
      (r) => r.days_idle >= input.min_idle_days
    );
    if (idleRds.length > 0) {
      results.rds_instances = idleRds.map((r) => ({
        instance_id: r.instance_id,
        name: r.name,
        type: r.instance_type,
        region: r.region,
        avg_connections: r.avg_connections,
        days_idle: r.days_idle,
        monthly_cost: `$${r.monthly_cost.toFixed(2)}`,
        recommendation: r.recommendation,
      }));
      totalMonthlyCost += idleRds.reduce((sum, r) => sum + r.monthly_cost, 0);
    }
  }

  if (input.resource_type === "all" || input.resource_type === "ebs") {
    const idleEbs = mockIdleResources.ebs_volumes.filter(
      (r) => r.days_unattached >= input.min_idle_days
    );
    if (idleEbs.length > 0) {
      results.ebs_volumes = idleEbs.map((r) => ({
        volume_id: r.volume_id,
        size: `${r.size_gb} GB`,
        region: r.region,
        days_unattached: r.days_unattached,
        monthly_cost: `$${r.monthly_cost.toFixed(2)}`,
        recommendation: r.recommendation,
      }));
      totalMonthlyCost += idleEbs.reduce((sum, r) => sum + r.monthly_cost, 0);
    }
  }

  const resourceCount = Object.values(results).reduce(
    (sum, arr) => sum + arr.length, 0
  );

  return {
    idle_resources_found: resourceCount,
    total_wasteful_spend: `$${totalMonthlyCost.toFixed(2)}/month`,
    potential_annual_savings: `$${(totalMonthlyCost * 12).toFixed(2)}/year`,
    ...results,
    action_required: resourceCount > 0
      ? `You have ${resourceCount} idle resources costing $${totalMonthlyCost.toFixed(2)}/month ($${(totalMonthlyCost * 12).toFixed(2)}/year). Immediate action recommended.`
      : "No idle resources found above the specified threshold.",
  };
}
