import { z } from "zod";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GroupDefinition,
} from "@aws-sdk/client-cost-explorer";
import { createLogger, getAwsCredentialContext, serializeError } from "../utils/fileLogger.js";

const log = createLogger("costSummary");

const client = new CostExplorerClient({});

log.info("CostExplorerClient initialized", {
  client_config: "default (AWS SDK credential provider chain)",
  credential_context: getAwsCredentialContext(),
});

export const costSummarySchema = z.object({
  period: z.enum(["last_7_days", "last_30_days", "last_3_months"]).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format").optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format").optional(),
  group_by: z.enum(["service", "region", "both"]).default("both"),
}).refine(
  (data) => data.period || (data.start_date && data.end_date),
  { message: "Either 'period' or both 'start_date' and 'end_date' must be provided" }
);

export type CostSummaryInput = z.infer<typeof costSummarySchema>;

function getDateRange(input: CostSummaryInput): { Start: string; End: string } {
  log.debug("Resolving date range", {
    period: input.period ?? null,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
  });

  if (input.start_date && input.end_date) {
    const range = { Start: input.start_date, End: input.end_date };
    log.info("Using custom date range", range);
    return range;
  }

  const end = new Date();
  const start = new Date();

  if (input.period === "last_7_days") start.setDate(end.getDate() - 7);
  else if (input.period === "last_3_months") start.setMonth(end.getMonth() - 3);
  else start.setDate(end.getDate() - 30);

  const range = {
    Start: start.toISOString().split("T")[0]!,
    End: end.toISOString().split("T")[0]!,
  };

  log.info("Computed preset date range", {
    period: input.period ?? "last_30_days (default)",
    ...range,
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
  });

  return range;
}

function formatAmount(amount: string | undefined): string {
  const num = parseFloat(amount ?? "0");
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 })}`;
}

async function fetchCostAndUsage(
  requestLog: ReturnType<typeof createLogger>,
  label: string,
  timePeriod: { Start: string; End: string },
  groupBy: GroupDefinition[]
) {
  const commandInput = {
    TimePeriod: timePeriod,
    Granularity: "MONTHLY" as const,
    Metrics: ["BlendedCost"],
    GroupBy: groupBy,
  };

  requestLog.info(`Preparing GetCostAndUsage API call (${label})`, {
    command: "GetCostAndUsage",
    input: commandInput,
    group_dimension: groupBy.map((g) => g.Key).join(", "),
  });

  const command = new GetCostAndUsageCommand(commandInput);
  const startMs = Date.now();

  requestLog.debug(`Sending GetCostAndUsage request (${label})`);

  const response = await client.send(command);
  const durationMs = Date.now() - startMs;

  const resultsByTime = response.ResultsByTime ?? [];
  const groupCount = resultsByTime.reduce((sum, tr) => sum + (tr.Groups?.length ?? 0), 0);

  requestLog.info(`GetCostAndUsage completed (${label})`, {
    duration_ms: durationMs,
    results_by_time_count: resultsByTime.length,
    total_groups: groupCount,
    response_metadata: response.$metadata ?? null,
    dimension_value_attributes_count: response.DimensionValueAttributes?.length ?? 0,
  });

  requestLog.debug(`GetCostAndUsage raw time buckets (${label})`, {
    time_buckets: resultsByTime.map((tr) => ({
      time_period: tr.TimePeriod,
      estimated: tr.Estimated,
      group_count: tr.Groups?.length ?? 0,
      groups: tr.Groups?.map((g) => ({
        keys: g.Keys,
        blended_cost: g.Metrics?.["BlendedCost"],
      })),
    })),
  });

  return response;
}

export async function getCostSummary(input: CostSummaryInput) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requestLog = log.child({ request_id: requestId });
  const overallStartMs = Date.now();

  requestLog.info("getCostSummary invoked", {
    input: {
      period: input.period ?? null,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
      group_by: input.group_by,
    },
    credential_context: getAwsCredentialContext(),
  });

  const timePeriod = getDateRange(input);
  const result: Record<string, unknown> = {
    period: input.period ?? "custom",
    date_range: `${timePeriod.Start} to ${timePeriod.End}`,
    currency: "USD",
  };

  requestLog.debug("Initial result shell built", { result_shell: result });

  try {
    if (input.group_by === "service" || input.group_by === "both") {
      requestLog.info("Starting service cost aggregation");
      const serviceGroups: GroupDefinition[] = [{ Type: "DIMENSION", Key: "SERVICE" }];
      const serviceResponse = await fetchCostAndUsage(
        requestLog,
        "by_service",
        timePeriod,
        serviceGroups
      );

      let total = 0;
      const serviceMap: Record<string, number> = {};

      for (const timeResult of serviceResponse.ResultsByTime ?? []) {
        requestLog.debug("Processing service time bucket", {
          time_period: timeResult.TimePeriod,
          group_count: timeResult.Groups?.length ?? 0,
        });

        for (const group of timeResult.Groups ?? []) {
          const name = group.Keys?.[0] ?? "Unknown";
          const amount = parseFloat(group.Metrics?.["BlendedCost"]?.Amount ?? "0");
          const unit = group.Metrics?.["BlendedCost"]?.Unit ?? "USD";
          const previous = serviceMap[name] ?? 0;
          serviceMap[name] = previous + amount;
          total += amount;

          requestLog.debug("Aggregated service group row", {
            service: name,
            amount,
            unit,
            running_total_for_service: serviceMap[name],
            running_grand_total: total,
          });
        }
      }

      const sorted = Object.entries(serviceMap)
        .sort((a, b) => b[1] - a[1])
        .filter(([, amount]) => amount > 0);

      requestLog.info("Service aggregation complete", {
        unique_services: Object.keys(serviceMap).length,
        services_with_cost: sorted.length,
        grand_total_usd: total,
        top_5_services: sorted.slice(0, 5).map(([service, amount]) => ({
          service,
          amount_usd: amount,
          formatted: formatAmount(amount.toString()),
        })),
      });

      result.total_cost = formatAmount(total.toString());
      result.by_service = sorted.map(([service, amount]) => ({
        service,
        cost: formatAmount(amount.toString()),
        percentage: total > 0 ? `${((amount / total) * 100).toFixed(1)}%` : "0%",
      }));

      if (sorted.length === 0) {
        result.note = "No cost data found for this period.";
        requestLog.warn("No service cost data returned for period", { time_period: timePeriod });
      } else {
        const top = (result.by_service as Array<Record<string, string>>)[0];
        result.insight = `Top spending service: ${top?.["service"]} at ${top?.["percentage"]} of total spend.`;
        requestLog.info("Service insight generated", { insight: result.insight });
      }
    } else {
      requestLog.debug("Skipping service aggregation (group_by excludes service)");
    }

    if (input.group_by === "region" || input.group_by === "both") {
      requestLog.info("Starting region cost aggregation");
      const regionGroups: GroupDefinition[] = [{ Type: "DIMENSION", Key: "REGION" }];
      const regionResponse = await fetchCostAndUsage(
        requestLog,
        "by_region",
        timePeriod,
        regionGroups
      );

      const regionMap: Record<string, number> = {};

      for (const timeResult of regionResponse.ResultsByTime ?? []) {
        requestLog.debug("Processing region time bucket", {
          time_period: timeResult.TimePeriod,
          group_count: timeResult.Groups?.length ?? 0,
        });

        for (const group of timeResult.Groups ?? []) {
          const name = group.Keys?.[0] ?? "Unknown";
          const amount = parseFloat(group.Metrics?.["BlendedCost"]?.Amount ?? "0");
          const previous = regionMap[name] ?? 0;
          regionMap[name] = previous + amount;

          requestLog.debug("Aggregated region group row", {
            region: name,
            amount,
            running_total_for_region: regionMap[name],
          });
        }
      }

      const sortedRegions = Object.entries(regionMap)
        .sort((a, b) => b[1] - a[1])
        .filter(([, amount]) => amount > 0);

      requestLog.info("Region aggregation complete", {
        unique_regions: Object.keys(regionMap).length,
        regions_with_cost: sortedRegions.length,
        top_5_regions: sortedRegions.slice(0, 5).map(([region, amount]) => ({
          region,
          amount_usd: amount,
          formatted: formatAmount(amount.toString()),
        })),
      });

      result.by_region = sortedRegions.map(([region, amount]) => ({
        region,
        cost: formatAmount(amount.toString()),
      }));

      if (sortedRegions.length === 0) {
        requestLog.warn("No region cost data returned for period", { time_period: timePeriod });
      }
    } else {
      requestLog.debug("Skipping region aggregation (group_by excludes region)");
    }

    const durationMs = Date.now() - overallStartMs;
    requestLog.info("getCostSummary completed successfully", {
      duration_ms: durationMs,
      result_keys: Object.keys(result),
      has_total_cost: "total_cost" in result,
      by_service_count: Array.isArray(result.by_service) ? result.by_service.length : 0,
      by_region_count: Array.isArray(result.by_region) ? result.by_region.length : 0,
    });

    requestLog.debug("Final result payload", { result });

    return result;

  } catch (error) {
    const durationMs = Date.now() - overallStartMs;
    requestLog.error("getCostSummary failed", {
      duration_ms: durationMs,
      error: serializeError(error),
      credential_context: getAwsCredentialContext(),
    });

    return {
      error: true,
      message: `Failed to fetch cost data: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Ensure your AWS credentials are configured and Cost Explorer is enabled in your account.",
    };
  }
}
