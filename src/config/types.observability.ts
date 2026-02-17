export type ObservabilityPricingTable = Record<
  string,
  {
    inputPer1kUsd?: number;
    outputPer1kUsd?: number;
  }
>;

export type ObservabilityAuditConfig = {
  enabled?: boolean;
  dir?: string;
  maxPayloadBytes?: number;
  maxQueueSize?: number;
};

export type ObservabilitySpendConfig = {
  enabled?: boolean;
  dir?: string;
  summaryPath?: string;
  pricing?: ObservabilityPricingTable;
};

export type ObservabilityHealthConfig = {
  enabled?: boolean;
  failureThreshold?: number;
  windowMs?: number;
  openMs?: number;
  emitIntervalMs?: number;
};

export type ObservabilityConfig = {
  enabled?: boolean;
  debug?: boolean;
  redactionMode?: "strict" | "debug";
  audit?: ObservabilityAuditConfig;
  spend?: ObservabilitySpendConfig;
  health?: ObservabilityHealthConfig;
};
