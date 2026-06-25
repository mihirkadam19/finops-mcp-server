import { z } from "zod";
import { BigQuery } from "@google-cloud/bigquery";
import { GoogleAuth, Impersonated } from "google-auth-library";
import { createLogger, serializeError } from "../../utils/fileLogger.js";

const log = createLogger("gcpCostSummary");

log.info("gcpCostSummary module loaded", {
  google_application_credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ? "set" : "missing",
  gcp_project_id: process.env.GCP_PROJECT_ID ? "set" : "missing",
});

export interface GcpCredentials {
  projectId: string;
  billingDataset: string;
  billingTable: string;
  datasetProjectId?: string;           // project hosting the dataset, defaults to projectId
  clientEmail?: string;                // service account email (inline key auth)
  privateKey?: string;                 // service account private key (inline key auth)
  impersonateServiceAccount?: string;  // service account email to impersonate via ADC
}

async function createClient(credentials: GcpCredentials): Promise<BigQuery> {
  // Option 1: inline service account key — same pattern as AWS/Azure inline creds
  if (credentials.clientEmail && credentials.privateKey) {
    return new BigQuery({
      projectId: credentials.projectId,
      credentials: {
        client_email: credentials.clientEmail,
        private_key: credentials.privateKey.replace(/\\n/g, "\n"),
      },
    });
  }

  // Option 2: impersonate a service account using ADC as the source identity
  // (gcloud auth application-default login, or GOOGLE_APPLICATION_CREDENTIALS)
  if (credentials.impersonateServiceAccount) {
    const sourceAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const sourceClient = await sourceAuth.getClient();
    const impersonated = new Impersonated({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sourceClient: sourceClient as any,
      targetPrincipal: credentials.impersonateServiceAccount,
      lifetime: 3600,
      delegates: [],
      targetScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const bq = new BigQuery({ projectId: credentials.projectId });
    // Inject impersonated credentials into BigQuery's internal GoogleAuth instance
    (bq as unknown as { auth: { cachedCredential: unknown } }).auth.cachedCredential = impersonated;
    return bq;
  }

  // Option 3: ADC fallback — GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth application-default login`
  return new BigQuery({ projectId: credentials.projectId });
}

export const gcpCostSummarySchema = z.object({
  period: z.enum(["last_7_days", "last_30_days", "last_3_months"]).default("last_30_days"),
  group_by: z.enum(["service", "project", "both"]).default("both"),
});

export type GcpCostSummaryInput = z.infer<typeof gcpCostSummarySchema>;

function getDateRange(period: string): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();

  if (period === "last_7_days") start.setDate(end.getDate() - 7);
  else if (period === "last_3_months") start.setMonth(end.getMonth() - 3);
  else start.setDate(end.getDate() - 30);

  return {
    startDate: start.toISOString().split("T")[0]!,
    endDate: end.toISOString().split("T")[0]!,
  };
}

function formatAmount(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Net cost = raw cost + credits (credits are negative amounts in GCP billing export)
const NET_COST_EXPR = `SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0))`;

export async function getGcpCostSummary(
  input: GcpCostSummaryInput,
  credentials: GcpCredentials
) {
  const requestLog = log.child({
    request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });
  const startMs = Date.now();

  requestLog.info("getGcpCostSummary invoked", { input });

  try {
    const client = await createClient(credentials);
    const { startDate, endDate } = getDateRange(input.period);
    const datasetProject = credentials.datasetProjectId ?? credentials.projectId;
    const tableRef = `\`${datasetProject}.${credentials.billingDataset}.${credentials.billingTable}\``;

    requestLog.info("BigQuery table reference built", {
      table_ref: tableRef,
      date_range: `${startDate} to ${endDate}`,
    });

    const result: Record<string, unknown> = {
      period: input.period,
      date_range: `${startDate} to ${endDate}`,
      currency: "USD",
      note: "Costs shown are net (after credits).",
    };

    if (input.group_by === "service" || input.group_by === "both") {
      requestLog.info("Querying costs by service");

      const query = `
        SELECT
          service.description AS service,
          ${NET_COST_EXPR} AS net_cost
        FROM ${tableRef}
        WHERE DATE(_PARTITIONTIME) BETWEEN @start_date AND @end_date
          AND cost != 0
        GROUP BY service
        ORDER BY net_cost DESC
      `;

      const [rows] = await client.query({
        query,
        params: { start_date: startDate, end_date: endDate },
        useLegacySql: false,
      });

      let total = 0;
      const services: { service: string; cost: number }[] = [];

      for (const row of rows as Array<{ service: string; net_cost: number }>) {
        const cost = Number(row.net_cost ?? 0);
        total += cost;
        services.push({ service: row.service ?? "Unknown", cost });
      }

      requestLog.info("Service cost query complete", {
        service_count: services.length,
        total_cost_usd: total,
        duration_ms: Date.now() - startMs,
      });

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

    if (input.group_by === "project" || input.group_by === "both") {
      requestLog.info("Querying costs by project");

      const query = `
        SELECT
          project.id AS project_id,
          project.name AS project_name,
          ${NET_COST_EXPR} AS net_cost
        FROM ${tableRef}
        WHERE DATE(_PARTITIONTIME) BETWEEN @start_date AND @end_date
          AND cost != 0
        GROUP BY project_id, project_name
        ORDER BY net_cost DESC
      `;

      const [rows] = await client.query({
        query,
        params: { start_date: startDate, end_date: endDate },
        useLegacySql: false,
      });

      const projects: { project_id: string; project_name: string; cost: number }[] = [];

      for (const row of rows as Array<{
        project_id: string;
        project_name: string;
        net_cost: number;
      }>) {
        projects.push({
          project_id: row.project_id ?? "Unknown",
          project_name: row.project_name || row.project_id || "Unknown",
          cost: Number(row.net_cost ?? 0),
        });
      }

      requestLog.info("Project cost query complete", {
        project_count: projects.length,
        duration_ms: Date.now() - startMs,
      });

      result.by_project = projects.map((p) => ({
        project_id: p.project_id,
        project_name: p.project_name,
        cost: formatAmount(p.cost),
      }));
    }

    requestLog.info("getGcpCostSummary completed", {
      duration_ms: Date.now() - startMs,
      result_keys: Object.keys(result),
    });

    return result;
  } catch (error) {
    requestLog.error("getGcpCostSummary failed", {
      duration_ms: Date.now() - startMs,
      error: serializeError(error),
    });

    return {
      error: true,
      message: `Failed to fetch GCP cost data: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure: 1) BigQuery billing export is enabled and the table exists, 2) Your service account has BigQuery Data Viewer role, 3) GCP_PROJECT_ID, GCP_BILLING_DATASET, and GCP_BILLING_TABLE are correctly set.",
    };
  }
}
