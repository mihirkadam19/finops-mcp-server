import { z } from "zod";
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
  type ResourceTagMapping,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { createLogger, getAwsCredentialContext, serializeError } from "../utils/fileLogger.js";

const log = createLogger("taggingCompliance");
const taggingClient = new ResourceGroupsTaggingAPIClient({});

log.info("ResourceGroupsTaggingAPIClient initialized", {
  credential_context: getAwsCredentialContext(),
});

const REQUIRED_TAGS = ["Environment", "Owner", "CostCenter", "Project"];

const RESOURCE_TYPE_FILTERS: Record<string, string[]> = {
  "EC2 Instance": ["ec2:instance"],
  "RDS Instance": ["rds:db"],
  "EBS Volume":   ["ec2:volume"],
  "S3 Bucket":    ["s3"],
};

export const taggingSchema = z.object({
  show_violations_only: z.boolean().default(true),
  resource_type: z.enum(["all", "EC2 Instance", "RDS Instance", "EBS Volume", "S3 Bucket"]).default("all"),
});

export type TaggingInput = z.infer<typeof taggingSchema>;

function extractRegionFromArn(arn: string): string {
  return arn.split(":")[3] || "global";
}

function extractResourceTypeFromArn(arn: string): string {
  const parts = arn.split(":");
  const service = parts[2] ?? "";
  const resourcePart = parts[5] ?? "";
  const resourcePrefix = resourcePart.split("/")[0] ?? resourcePart;

  if (service === "ec2") {
    if (resourcePrefix === "instance") return "EC2 Instance";
    if (resourcePrefix === "volume")   return "EBS Volume";
  }
  if (service === "rds" && resourcePrefix === "db") return "RDS Instance";
  if (service === "s3") return "S3 Bucket";

  return `${service}:${resourcePrefix}`;
}

function extractNameFromArn(arn: string, tags: Record<string, string>): string {
  if (tags["Name"]) return tags["Name"];
  const parts = arn.split(":");
  const resourcePart = parts[parts.length - 1] ?? arn;
  return resourcePart.includes("/") ? (resourcePart.split("/").pop() ?? resourcePart) : resourcePart;
}

function getMissingTags(tags: Record<string, string>): string[] {
  return REQUIRED_TAGS.filter((tag) => !tags[tag]);
}

function buildTagMap(resource: ResourceTagMapping): Record<string, string> {
  const map: Record<string, string> = {};
  for (const tag of resource.Tags ?? []) {
    if (tag.Key) map[tag.Key] = tag.Value ?? "";
  }
  return map;
}

export async function getTaggingCompliance(input: TaggingInput) {
  const requestLog = log.child({ request_id: `req_${Date.now()}` });
  const startMs = Date.now();

  requestLog.info("getTaggingCompliance invoked", {
    input,
    credential_context: getAwsCredentialContext(),
  });

  try {
    const resourceTypeFilters =
      input.resource_type !== "all" ? RESOURCE_TYPE_FILTERS[input.resource_type] : undefined;

    // Paginate through all resources
    const allResources: ResourceTagMapping[] = [];
    let paginationToken: string | undefined;
    let page = 0;

    do {
      page += 1;
      requestLog.info(`Fetching page ${page}`, { pagination_token: paginationToken });

      const response = await taggingClient.send(
        new GetResourcesCommand({
          ResourceTypeFilters: resourceTypeFilters,
          ResourcesPerPage: 100,
          ...(paginationToken && { PaginationToken: paginationToken }),
        })
      );

      const pageItems = response.ResourceTagMappingList ?? [];
      allResources.push(...pageItems);
      paginationToken = response.PaginationToken || undefined;

      requestLog.info(`Page ${page} received`, {
        page_count: pageItems.length,
        total_so_far: allResources.length,
        has_next_page: Boolean(paginationToken),
      });
    } while (paginationToken);

    requestLog.info("Pagination complete", {
      total_resources: allResources.length,
      duration_ms: Date.now() - startMs,
    });

    // Evaluate each resource for tag compliance
    type Violation = {
      resource_id: string;
      resource_type: string;
      name: string;
      region: string;
      missing_tags: string[];
    };

    const violations: Violation[] = [];
    let compliantCount = 0;

    for (const resource of allResources) {
      const arn = resource.ResourceARN ?? "";
      const tags = buildTagMap(resource);
      const missingTags = getMissingTags(tags);

      if (missingTags.length === 0) {
        compliantCount += 1;
        continue;
      }

      violations.push({
        resource_id: arn,
        resource_type: extractResourceTypeFromArn(arn),
        name: extractNameFromArn(arn, tags),
        region: extractRegionFromArn(arn),
        missing_tags: missingTags,
      });
    }

    const totalResources = allResources.length;
    const nonCompliantCount = violations.length;
    const complianceRate =
      totalResources > 0 ? Math.round((compliantCount / totalResources) * 100) : 100;

    requestLog.info("getTaggingCompliance completed", {
      total_resources: totalResources,
      compliant: compliantCount,
      non_compliant: nonCompliantCount,
      compliance_rate: complianceRate,
      duration_ms: Date.now() - startMs,
    });

    if (totalResources === 0) {
      return {
        overall_compliance_rate: "100%",
        total_resources_scanned: 0,
        compliant: 0,
        non_compliant: 0,
        required_tags: REQUIRED_TAGS,
        violations_found: 0,
        violations: [],
        summary: "No resources found. Ensure the AWS credentials have tag:GetResources permission and resources exist in the account.",
        recommendation: "Enforce tagging via AWS Config rules or SCP policies to prevent untagged resources from being created.",
      };
    }

    return {
      overall_compliance_rate: `${complianceRate}%`,
      total_resources_scanned: totalResources,
      compliant: compliantCount,
      non_compliant: nonCompliantCount,
      required_tags: REQUIRED_TAGS,
      violations_found: violations.length,
      violations: violations.map((v) => ({
        resource_id: v.resource_id,
        resource_type: v.resource_type,
        name: v.name,
        region: v.region,
        missing_tags: v.missing_tags,
      })),
      summary: `${complianceRate}% of ${totalResources} scanned resources are compliant. ${nonCompliantCount} resource(s) are missing required tags (${REQUIRED_TAGS.join(", ")}).`,
      recommendation: "Enforce tagging via AWS Config rules or SCP policies to prevent untagged resources from being created.",
    };

  } catch (error) {
    requestLog.error("getTaggingCompliance failed", {
      duration_ms: Date.now() - startMs,
      error: serializeError(error),
      credential_context: getAwsCredentialContext(),
    });

    return {
      error: true,
      message: `Failed to fetch tagging compliance data: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure AWS credentials are configured with tag:GetResources permission.",
    };
  }
}
