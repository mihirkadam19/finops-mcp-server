# Cloud FinOps Analyst — MCP Server

An AI-powered AWS cost analysis tool built as a Model Context Protocol (MCP) server. Connect it to Claude and ask plain-English questions about your cloud spend.

## What it does

Instead of digging through AWS Cost Explorer dashboards, just ask:

- *"What did we spend last month and where is the money going?"*
- *"Did we have any unexpected cost spikes this week?"*
- *"Which resources are we paying for but not using?"*
- *"Which instances are over-provisioned and how much could we save?"*
- *"How bad is our tagging compliance and how much spend is unallocated?"*

Claude calls the right tools, pulls the data, and gives you a clear analysis with specific recommendations.

---

## Tools

| Tool | Description |
|---|---|
| `get_cost_summary` | Cost breakdown by service and region for last 7 days, 30 days, or 3 months |
| `detect_cost_anomalies` | Flags unusual spending spikes with likely root causes |
| `get_idle_resources` | Finds unused EC2 instances, RDS databases, and unattached EBS volumes |
| `get_rightsizing_recommendations` | Suggests downsizing over-provisioned instances with estimated savings |
| `get_tagging_compliance` | Identifies untagged resources and unallocatable spend |

---

## Architecture

```
You (chat in Claude Desktop or Claude.ai)
        ↓
Claude (AI reasoning — decides which tools to call)
        ↓
This MCP Server (fetches and returns data)
        ↓
AWS APIs (Cost Explorer, EC2, RDS, S3)
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Claude Desktop (free) — [download here](https://claude.ai/download)

### Installation

```bash
git clone https://github.com/yourusername/finops-mcp-server
cd finops-mcp-server
npm install
npm run build
```

### Connect to Claude Desktop

Add this to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "finops-analyst": {
      "command": "node",
      "args": ["/absolute/path/to/finops-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. You'll see the tools icon appear in the chat interface.

---

## AWS Setup (for real data)

> The server currently runs with mock data. To connect to a real AWS account:

1. Create an IAM user with read-only permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ce:GetCostAndUsage",
        "ce:GetCostForecast",
        "ce:GetAnomalies",
        "ec2:DescribeInstances",
        "ec2:DescribeVolumes",
        "rds:DescribeDBInstances",
        "cloudwatch:GetMetricStatistics",
        "tag:GetResources"
      ],
      "Resource": "*"
    }
  ]
}
```

2. Add credentials to your environment:

```bash
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret
export AWS_DEFAULT_REGION=us-east-1
```

3. Replace the mock data calls in each tool file with real AWS SDK calls.

---

## Example Conversations

**Cost overview:**
> "Give me a breakdown of our AWS spend last month"

**Anomaly investigation:**
> "Why did our bill spike last week? What caused it?"

**Cost optimization:**
> "What are the quickest wins to reduce our AWS bill right now?"

**Executive report:**
> "Summarize our cloud cost health and give me 3 priority actions I can bring to my manager"

---

## Project Structure

```
finops-mcp-server/
├── src/
│   ├── index.ts              # MCP server entry point + tool registry
│   ├── tools/
│   │   ├── costSummary.ts        # get_cost_summary
│   │   ├── anomalyDetection.ts   # detect_cost_anomalies
│   │   ├── idleResources.ts      # get_idle_resources
│   │   ├── rightsizing.ts        # get_rightsizing_recommendations
│   │   └── taggingCompliance.ts  # get_tagging_compliance
│   └── data/
│       └── mockData.ts           # Realistic mock AWS data for demos
├── dist/                     # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Roadmap

- [ ] Connect to real AWS Cost Explorer API
- [ ] Add Reserved Instance vs On-Demand comparison tool
- [ ] Add savings plan coverage analysis
- [ ] Phase 2: Web app with React frontend + Express backend

---

## Tech Stack

- **TypeScript** — type-safe tool definitions
- **MCP SDK** (`@modelcontextprotocol/sdk`) — server protocol
- **Zod** — input schema validation
- **Node.js** — runtime
