import { z } from "zod";
import { ClientSecretCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { MonitorClient } from "@azure/arm-monitor";
import { SqlManagementClient } from "@azure/arm-sql";
import { PostgreSQLManagementFlexibleServerClient } from "@azure/arm-postgresql-flexible";
import { MySQLManagementFlexibleServerClient } from "@azure/arm-mysql-flexible";
import type { AzureCredentials } from "./azureCostSummary";
import { createLogger, serializeError } from "../../utils/fileLogger.js";

const log = createLogger("azureIdleResources");
log.info("azureIdleResources module loaded");

export const azureIdleResourcesSchema = z.object({
  min_idle_days: z.number().default(7).describe("Minimum number of days of low CPU usage to flag a VM as idle"),
  cpu_threshold_percent: z.number().default(5).describe("Average CPU% below which a VM is considered idle"),
});

export type AzureIdleResourcesInput = z.infer<typeof azureIdleResourcesSchema>;

function parseResourceGroup(resourceId: string): string {
  const match = resourceId.match(/resourceGroups\/([^/]+)/i);
  return match ? match[1]! : "unknown";
}

export async function getAzureIdleResources(
  input: AzureIdleResourcesInput,
  credentials: AzureCredentials
) {
  const requestLog = log.child({ request_id: `req_${Date.now()}` });
  const startMs = Date.now();

  requestLog.info("getAzureIdleResources invoked", { input });

  try {
    const credential = new ClientSecretCredential(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    const computeClient = new ComputeManagementClient(credential, credentials.subscriptionId);
    const monitorClient = new MonitorClient(credential, credentials.subscriptionId);
    const sqlClient = new SqlManagementClient(credential, credentials.subscriptionId);
    const pgClient = new PostgreSQLManagementFlexibleServerClient(credential, credentials.subscriptionId);
    const mysqlClient = new MySQLManagementFlexibleServerClient(credential, credentials.subscriptionId);

    const vms = [];
    for await (const vm of computeClient.virtualMachines.listAll()) {
      vms.push(vm);
    }

    requestLog.info("Listed virtual machines", { count: vms.length });

    const endTime = new Date();
    const startTime = new Date();
    startTime.setDate(endTime.getDate() - input.min_idle_days);

    const idleVms: {
      name: string;
      resource_group: string;
      location: string;
      vm_size: string;
      avg_cpu_percent: string;
      power_state: string;
      recommendation: string;
    }[] = [];

    const idleDatabases: {
      name: string;
      resource_group: string;
      location: string;
      kind: string;
      tier: string;
      avg_cpu_percent: string;
      recommendation: string;
    }[] = [];

    const getAvgCpu = async (resourceId: string): Promise<number | null> => {
      try {
        const metricsResponse = await monitorClient.metrics.list(resourceId, {
          timespan: `${startTime.toISOString()}/${endTime.toISOString()}`,
          interval: "P1D",
          metricnames: "cpu_percent",
          aggregation: "Average",
        });
        const data = metricsResponse.value?.[0]?.timeseries?.[0]?.data ?? [];
        const values = data.map((d) => d.average).filter((v): v is number => typeof v === "number");
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
      } catch {
        return null;
      }
    };

    for (const vm of vms) {
      if (!vm.id || !vm.name) continue;

      const resourceGroup = parseResourceGroup(vm.id);
      const location = vm.location ?? "unknown";
      const vmSize = vm.hardwareProfile?.vmSize ?? "unknown";

      // Get power state
      let powerState = "unknown";
      try {
        const instanceView = await computeClient.virtualMachines.instanceView(resourceGroup, vm.name);
        const statusEntry = instanceView.statuses?.find((s) => s.code?.startsWith("PowerState/"));
        powerState = statusEntry?.code?.replace("PowerState/", "") ?? "unknown";
      } catch {
        // ignore, leave as unknown
      }

      // Skip deallocated/stopped VMs - they're already not incurring compute cost
      if (powerState !== "running") continue;

      // Get average CPU over the period
      let avgCpu: number | null = null;
      try {
        const metricsResponse = await monitorClient.metrics.list(vm.id, {
          timespan: `${startTime.toISOString()}/${endTime.toISOString()}`,
          interval: "P1D",
          metricnames: "Percentage CPU",
          aggregation: "Average",
        });

        const timeseries = metricsResponse.value?.[0]?.timeseries?.[0]?.data ?? [];
        const values = timeseries
          .map((d) => d.average)
          .filter((v): v is number => typeof v === "number");

        if (values.length > 0) {
          avgCpu = values.reduce((a, b) => a + b, 0) / values.length;
        }
      } catch (metricError) {
        requestLog.error("Failed to fetch metrics for VM", {
          vm: vm.name,
          error: serializeError(metricError),
        });
      }

      if (avgCpu !== null && avgCpu < input.cpu_threshold_percent) {
        idleVms.push({
          name: vm.name,
          resource_group: resourceGroup,
          location,
          vm_size: vmSize,
          avg_cpu_percent: avgCpu.toFixed(2),
          power_state: powerState,
          recommendation: `Average CPU of ${avgCpu.toFixed(2)}% over ${input.min_idle_days} days suggests this VM is underutilized. Consider downsizing or deallocating.`,
        });
      }
    }

    // Azure SQL Databases
    let sqlDbsScanned = 0;
    try {
      for await (const server of sqlClient.servers.list()) {
        if (!server.id || !server.name) continue;
        const rg = parseResourceGroup(server.id);
        for await (const db of sqlClient.databases.listByServer(rg, server.name)) {
          if (!db.id || !db.name || db.name === "master") continue;
          sqlDbsScanned++;
          const avgCpu = await getAvgCpu(db.id);
          if (avgCpu !== null && avgCpu < input.cpu_threshold_percent) {
            idleDatabases.push({
              name: `${server.name}/${db.name}`,
              resource_group: rg,
              location: db.location ?? "unknown",
              kind: "Azure SQL Database",
              tier: db.sku?.tier ?? db.sku?.name ?? "unknown",
              avg_cpu_percent: avgCpu.toFixed(2),
              recommendation: `Average CPU of ${avgCpu.toFixed(2)}% over ${input.min_idle_days} days. Consider scaling down or pausing.`,
            });
          }
        }
      }
    } catch (sqlError) {
      requestLog.error("Failed to scan Azure SQL databases", { error: serializeError(sqlError) });
    }

    // PostgreSQL Flexible Servers
    let pgServersScanned = 0;
    try {
      for await (const server of pgClient.servers.listBySubscription()) {
        if (!server.id || !server.name) continue;
        pgServersScanned++;
        const rg = parseResourceGroup(server.id);
        const avgCpu = await getAvgCpu(server.id);
        if (avgCpu !== null && avgCpu < input.cpu_threshold_percent) {
          idleDatabases.push({
            name: server.name,
            resource_group: rg,
            location: server.location ?? "unknown",
            kind: "PostgreSQL Flexible Server",
            tier: server.sku?.tier ?? "unknown",
            avg_cpu_percent: avgCpu.toFixed(2),
            recommendation: `Average CPU of ${avgCpu.toFixed(2)}% over ${input.min_idle_days} days. Consider stopping or downsizing.`,
          });
        }
      }
    } catch (pgError) {
      requestLog.error("Failed to scan PostgreSQL Flexible Servers", { error: serializeError(pgError) });
    }

    // MySQL Flexible Servers
    let mysqlServersScanned = 0;
    try {
      for await (const server of mysqlClient.servers.list()) {
        if (!server.id || !server.name) continue;
        mysqlServersScanned++;
        const rg = parseResourceGroup(server.id);
        const avgCpu = await getAvgCpu(server.id);
        if (avgCpu !== null && avgCpu < input.cpu_threshold_percent) {
          idleDatabases.push({
            name: server.name,
            resource_group: rg,
            location: server.location ?? "unknown",
            kind: "MySQL Flexible Server",
            tier: server.sku?.tier ?? "unknown",
            avg_cpu_percent: avgCpu.toFixed(2),
            recommendation: `Average CPU of ${avgCpu.toFixed(2)}% over ${input.min_idle_days} days. Consider stopping or downsizing.`,
          });
        }
      }
    } catch (mysqlError) {
      requestLog.error("Failed to scan MySQL Flexible Servers", { error: serializeError(mysqlError) });
    }

    requestLog.info("Database scan complete", {
      sql_dbs_scanned: sqlDbsScanned,
      pg_servers_scanned: pgServersScanned,
      mysql_servers_scanned: mysqlServersScanned,
      idle_databases_found: idleDatabases.length,
    });

    const totalIdleResources = idleVms.length + idleDatabases.length;

    const result = {
      idle_resources_found: totalIdleResources,
      vms_scanned: vms.length,
      databases_scanned: sqlDbsScanned + pgServersScanned + mysqlServersScanned,
      min_idle_days: input.min_idle_days,
      cpu_threshold_percent: input.cpu_threshold_percent,
      idle_vms: idleVms,
      idle_databases: idleDatabases,
      action_required:
        totalIdleResources > 0
          ? `Found ${idleVms.length} idle VM(s) and ${idleDatabases.length} idle database(s) with average CPU below ${input.cpu_threshold_percent}% over the last ${input.min_idle_days} days. Review for downsizing or deallocation.`
          : "No idle VMs or databases found above the specified threshold.",
    };

    requestLog.info("getAzureIdleResources completed successfully", {
      duration_ms: Date.now() - startMs,
      idle_found: idleVms.length,
    });

    return result;
  } catch (error) {
    requestLog.error("getAzureIdleResources failed", {
      duration_ms: Date.now() - startMs,
      error: serializeError(error),
    });

    return {
      error: true,
      message: `Failed to fetch Azure idle resources: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure your Azure service principal has Reader role on the subscription, with access to Compute and Monitor resource providers.",
    };
  }
}
