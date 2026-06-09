import { z } from "zod";
import { mockTaggingCompliance } from "../data/mockData.js";

export const taggingSchema = z.object({
  show_violations_only: z.boolean().default(true),
  resource_type: z.enum(["all", "EC2 Instance", "RDS Instance", "EBS Volume", "S3 Bucket"]).default("all"),
});

export type TaggingInput = z.infer<typeof taggingSchema>;

export function getTaggingCompliance(input: TaggingInput) {
  const data = mockTaggingCompliance;

  let violations = data.violations;
  if (input.resource_type !== "all") {
    violations = violations.filter((v) => v.resource_type === input.resource_type);
  }

  const unallocatableCost = violations.reduce((sum, v) => sum + v.monthly_cost, 0);

  return {
    overall_compliance_rate: `${data.overall_compliance_rate}%`,
    total_resources_scanned: data.total_resources,
    compliant: data.compliant_resources,
    non_compliant: data.non_compliant_resources,
    required_tags: data.required_tags,
    unallocatable_monthly_spend: `$${data.unallocatable_spend.toFixed(2)}`,
    violations_shown: violations.length,
    violations: violations.map((v) => ({
      resource_id: v.resource_id,
      resource_type: v.resource_type,
      name: v.resource_name,
      region: v.region,
      missing_tags: v.missing_tags,
      monthly_cost: `$${v.monthly_cost.toFixed(2)}`,
      impact: `This resource's $${v.monthly_cost.toFixed(2)}/month spend cannot be attributed to a team, project, or cost center.`,
    })),
    summary: `${data.overall_compliance_rate}% compliance rate. $${data.unallocatable_spend.toFixed(2)}/month in spend cannot be allocated to teams or projects due to missing tags. Fixing tagging on the top violators would immediately improve cost visibility.`,
    recommendation: "Enforce tagging via AWS Config rules or SCP policies to prevent untagged resources from being created in the future.",
  };
}
