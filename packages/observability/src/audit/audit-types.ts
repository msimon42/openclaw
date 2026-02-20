export type AuditSchemaVersion = "1.0";
export type AuditEventVersion = "1.0";

export type AuditRiskTier = "low" | "medium" | "high" | "critical";

export type AuditDecision = {
  outcome: "allow" | "deny";
  reason: string;
  ruleId?: string;
};

export type ModelAuditMeta = {
  provider?: string;
  modelRef?: string;
  route?: string;
  fromModelRef?: string;
  toModelRef?: string;
  statusCode?: number;
  errorCode?: string;
};

export type ToolAuditMeta = {
  toolName?: string;
  toolCallId?: string;
  blocked?: boolean;
};

export type AuditMetrics = {
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  retries?: number;
  fallbackHops?: number;
  toolCalls?: number;
  blockedToolCalls?: number;
  delegationCalls?: number;
  delegationMessages?: number;
  artifactsPublished?: number;
  artifactsFetched?: number;
};

export type AuditEvent = {
  schemaVersion: AuditSchemaVersion;
  eventVersion: AuditEventVersion;
  timestamp: number;
  traceId: string;
  spanId?: string;
  agentId: string;
  skillId?: string;
  pluginId?: string;
  eventType: string;
  riskTier?: AuditRiskTier;
  decision?: AuditDecision;
  model?: ModelAuditMeta;
  tool?: ToolAuditMeta;
  metrics?: AuditMetrics;
  payload: Record<string, unknown>;
};

export type SerializedAuditEvent = AuditEvent;

export type AuditEventInput = Omit<AuditEvent, "schemaVersion" | "eventVersion" | "timestamp"> & {
  schemaVersion?: AuditSchemaVersion;
  eventVersion?: AuditEventVersion;
  timestamp?: number;
};

export type AuditSink = {
  write: (event: SerializedAuditEvent) => void | Promise<void>;
  flush?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
};

export const AUDIT_EVENT_JSON_SCHEMA_V1 = {
  $id: "openclaw.audit.event.v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "eventVersion",
    "timestamp",
    "traceId",
    "agentId",
    "eventType",
    "payload",
  ],
  properties: {
    schemaVersion: { const: "1.0" },
    eventVersion: { const: "1.0" },
    timestamp: { type: "number" },
    traceId: { type: "string", minLength: 1 },
    spanId: { type: "string" },
    agentId: { type: "string", minLength: 1 },
    skillId: { type: "string" },
    pluginId: { type: "string" },
    eventType: { type: "string", minLength: 1 },
    riskTier: { enum: ["low", "medium", "high", "critical"] },
    decision: {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "reason"],
      properties: {
        outcome: { enum: ["allow", "deny"] },
        reason: { type: "string" },
        ruleId: { type: "string" },
      },
    },
    model: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string" },
        modelRef: { type: "string" },
        route: { type: "string" },
        fromModelRef: { type: "string" },
        toModelRef: { type: "string" },
        statusCode: { type: "number" },
        errorCode: { type: "string" },
      },
    },
    tool: {
      type: "object",
      additionalProperties: false,
      properties: {
        toolName: { type: "string" },
        toolCallId: { type: "string" },
        blocked: { type: "boolean" },
      },
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      properties: {
        latencyMs: { type: "number" },
        tokensIn: { type: "number" },
        tokensOut: { type: "number" },
        costUsd: { type: "number" },
        retries: { type: "number" },
        fallbackHops: { type: "number" },
        toolCalls: { type: "number" },
        blockedToolCalls: { type: "number" },
        delegationCalls: { type: "number" },
        delegationMessages: { type: "number" },
        artifactsPublished: { type: "number" },
        artifactsFetched: { type: "number" },
      },
    },
    payload: { type: "object" },
  },
} as const;
