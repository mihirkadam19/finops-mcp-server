import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getCostSummary, costSummarySchema } from "./tools/aws/awsCostSummary.js";
import { detectAnomalies, anomalySchema } from "./tools/aws/awsAnomalyDetection.js";
import { getIdleResources, idleResourcesSchema } from "./tools/aws/awsIdleResources.js";
import { getTaggingCompliance, taggingSchema } from "./tools/aws/awsTaggingCompliance.js";


import { getAzureCostSummary, azureCostSummarySchema } from "./tools/azure/azureCostSummary.js";
import { getAzureIdleResources, azureIdleResourcesSchema } from "./tools/azure/azureIdleResources.js";
import { detectAzureAnomalies, azureAnomalySchema } from "./tools/azure/azureAnomalyDetection.js";

const server = new McpServer({
  name: "finops-analyst",
  version: "1.0.0",
});


// ─── Tool: Get Azure Cost Summary ─────────────────────────────────────────────
server.tool(
  "get_azure_cost_summary",
  "Fetches Azure cost breakdown by service and resource group for a given time period.",
  {
    period: z.enum(["last_7_days", "last_30_days", "last_3_months"])
      .default("last_30_days")
      .describe("Time period to analyze"),
    group_by: z.enum(["service", "resource_group", "both"])
      .default("both")
      .describe("How to group the cost breakdown"),
  },
  async (input) => {
    const credentials = {
      tenantId: process.env.AZURE_TENANT_ID ?? "",
      clientId: process.env.AZURE_CLIENT_ID ?? "",
      clientSecret: process.env.AZURE_CLIENT_SECRET ?? "",
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? "",
    };

    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret || !credentials.subscriptionId) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: "Azure credentials not configured.",
            hint: "Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID in Claude Desktop config env.",
          }),
        }],
      };
    }

    const result = await getAzureCostSummary(azureCostSummarySchema.parse(input), credentials);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Tool: Get Azure Idle Resources ───────────────────────────────────────────
server.tool(
  "get_azure_idle_resources",
  "Identifies idle/underutilized Azure VMs based on average CPU usage over a time period.",
  {
    min_idle_days: z.number().default(7).describe("Number of days to analyze for idle detection"),
    cpu_threshold_percent: z.number().default(5).describe("CPU% threshold below which a VM is considered idle"),
  },
  async (input) => {
    const credentials = {
      tenantId: process.env.AZURE_TENANT_ID ?? "",
      clientId: process.env.AZURE_CLIENT_ID ?? "",
      clientSecret: process.env.AZURE_CLIENT_SECRET ?? "",
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? "",
    };

    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret || !credentials.subscriptionId) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: "Azure credentials not configured.",
            hint: "Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID in Claude Desktop config env.",
          }),
        }],
      };
    }

    const result = await getAzureIdleResources(azureIdleResourcesSchema.parse(input), credentials);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Tool: Detect Azure Cost Anomalies ────────────────────────────────────────
server.tool(
  "detect_azure_cost_anomalies",
  "Detects daily Azure cost spikes by comparing each day's spend against the period average.",
  {
    lookback_days: z.number().default(30).describe("Number of days of cost history to analyze"),
    min_spike_percentage: z.number().default(50).describe("Minimum % above average to flag as an anomaly"),
  },
  async (input) => {
    const credentials = {
      tenantId: process.env.AZURE_TENANT_ID ?? "",
      clientId: process.env.AZURE_CLIENT_ID ?? "",
      clientSecret: process.env.AZURE_CLIENT_SECRET ?? "",
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? "",
    };

    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret || !credentials.subscriptionId) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: "Azure credentials not configured.",
            hint: "Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID in Claude Desktop config env.",
          }),
        }],
      };
    }

    const result = await detectAzureAnomalies(azureAnomalySchema.parse(input), credentials);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Tool: Get AWS Cost Summary ───────────────────────────────────────────────────
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

// ─── Tool: Detect AWS Cost Anomalies ─────────────────────────────────────────────
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

// ─── Tool: Get AWS Idle Resources ─────────────────────────────────────────────────
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


// ─── Tool: Get AWS Tagging Compliance ─────────────────────────────────────────────
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
