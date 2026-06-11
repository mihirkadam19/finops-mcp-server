export { getCostSummary, type CostSummaryInput } from "./aws/awsCostSummary";
export { detectAnomalies, type AnomalyInput } from "./aws/awsAnomalyDetection";
export { getIdleResources, type IdleResourcesInput } from "./aws/awsIdleResources";
export { getTaggingCompliance, type TaggingInput } from "./aws/awsTaggingCompliance";
export type { AwsCredentials } from "./aws/awsCostSummary";
export {getAzureCostSummary, type AzureCostSummaryInput, type AzureCredentials } from "./azure/azureCostSummary";
export { getAzureIdleResources, azureIdleResourcesSchema, type AzureIdleResourcesInput } from "./azure/azureIdleResources";
export { detectAzureAnomalies, azureAnomalySchema, type AzureAnomalyInput } from "./azure/azureAnomalyDetection";