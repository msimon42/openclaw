export type SpendRecord = {
  timestamp: number;
  agentId: string;
  modelRef: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  traceId: string;
};

export type SpendSummaryByModel = {
  modelRef: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type SpendSummaryByAgent = {
  agentId: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type SpendSummary = {
  updatedAt: number;
  totals: {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  byModel: SpendSummaryByModel[];
  byAgent: SpendSummaryByAgent[];
};

export const SPEND_RECORD_JSON_SCHEMA_V1 = {
  $id: "openclaw.spend.record.v1",
  type: "object",
  additionalProperties: false,
  required: ["timestamp", "agentId", "modelRef", "traceId"],
  properties: {
    timestamp: { type: "number" },
    agentId: { type: "string", minLength: 1 },
    modelRef: { type: "string", minLength: 1 },
    tokensIn: { type: "number" },
    tokensOut: { type: "number" },
    costUsd: { type: "number" },
    traceId: { type: "string", minLength: 1 },
  },
} as const;
