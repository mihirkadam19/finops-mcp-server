import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getCostSummary, costSummarySchema } from "./tools/costSummary.js";
import { detectAnomalies, anomalySchema } from "./tools/anomalyDetection.js";
import { getIdleResources, idleResourcesSchema } from "./tools/idleResources.js";
import { getRightsizingRecommendations, rightsizingSchema } from "./tools/rightsizing.js";
import { getTaggingCompliance, taggingSchema } from "./tools/taggingCompliance.js";

const server = new McpServer({
  name: "finops-analyst",
  version: "1.0.0",
});

// ─── Tool: Get Cost Summary ───────────────────────────────────────────────────
server.tool(
  "get_cost_summary",
  "Fetches AWS cloud cost breakdown by service and region for a given time period. Use this to answer questions about overall spend, top spending services, or cost by region.",
  {
    period: z.enum(["last_7_days", "last_30_days", "last_3_months"])
      .optional()
      .describe("Preset time period to analyze"),
    start_date: z.string()
      .optional()
      .describe("Custom start date in YYYY-MM-DD format"),
    end_date: z.string()
      .optional()
      .describe("Custom end date in YYYY-MM-DD format"),
    group_by: z.enum(["service", "region", "both"])
      .default("both")
      .describe("How to group the cost breakdown"),
  },
  async (input) => {
    const result = await getCostSummary(costSummarySchema.parse(input));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Tool: Detect Cost Anomalies ─────────────────────────────────────────────
server.tool(
  "detect_cost_anomalies",
  "Detects unusual cost spikes across AWS services compared to baseline spending. Use this when asked about billing surprises, unexpected charges, or cost spikes.",
  {
    min_spike_percentage: z.number()
      .default(50)
      .describe("Minimum percentage increase over baseline to flag as anomaly"),
  },
  async (input) => {
    const result = await detectAnomalies(anomalySchema.parse(input));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Tool: Get Idle Resources ─────────────────────────────────────────────────
server.tool(
  "get_idle_resources",
  "Identifies idle or underutilized AWS resources including EC2 instances, RDS databases, and unattached EBS volumes that are wasting money. Use this when asked about waste, unused resources, or easy cost savings.",
  {
    resource_type: z.enum(["all", "ec2", "rds", "ebs"])
      .default("all")
      .describe("Type of resource to check"),
    min_idle_days: z.number()
      .default(7)
      .describe("Minimum number of days a resource must be idle to be included"),
  },
  async (input) => {
    const result = await getIdleResources(idleResourcesSchema.parse(input));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);


// ─── Tool: Get Tagging Compliance ─────────────────────────────────────────────
server.tool(
  "get_tagging_compliance",
  "Checks AWS resource tagging compliance — identifying resources missing required tags like Environment, Owner, CostCenter, and Project. Use this when asked about cost allocation, untagged resources, or tagging policies.",
  {
    show_violations_only: z.boolean()
      .default(true)
      .describe("Show only non-compliant resources"),
    resource_type: z.enum(["all", "EC2 Instance", "RDS Instance", "EBS Volume", "S3 Bucket"])
      .default("all")
      .describe("Filter by resource type"),
  },
  async (input) => {
    const result = await getTaggingCompliance(taggingSchema.parse(input));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Start Server ─────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("FinOps Analyst MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
