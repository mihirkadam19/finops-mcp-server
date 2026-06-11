import * as esbuild from "esbuild";
import fs from "fs";

// Clean dist
if (fs.existsSync("dist")) {
  fs.rmSync("dist", { recursive: true });
}

console.log("Building JS with esbuild...");

// Build MCP server entry point (bundled)
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  outdir: "dist",
  format: "cjs",
  target: "node18",
  external: [
    "@aws-sdk/*",
    "@modelcontextprotocol/*",
    "zod",
  ],
});

// Build tools as separate unbundled files for library use
await esbuild.build({
  entryPoints: [
    "src/tools/index.ts",
    "src/tools/aws/awsCostSummary.ts",
    "src/tools/aws/awsAnomalyDetection.ts",
    "src/tools/aws/awsIdleResources.ts",
    "src/tools/aws/awsTaggingCompliance.ts",
    "src/tools/azure/azureCostSummary.ts",
    "src/tools/azure/azureIdleResources.ts",
    "src/tools/azure/azureAnomalyDetection.ts",
  ],
  bundle: false,
  platform: "node",
  outdir: "dist/tools",
  format: "cjs",
  target: "node18",
});

// Build utils
await esbuild.build({
  entryPoints: ["src/utils/fileLogger.ts"],
  bundle: false,
  platform: "node",
  outdir: "dist/utils",
  format: "cjs",
  target: "node18",
});

console.log("Build complete!");
