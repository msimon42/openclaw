export const OBS_SCHEMA_VERSION = "1.0" as const;

export const OBS_METHOD_SUBSCRIBE = "OBS.SUBSCRIBE" as const;
export const OBS_METHOD_UNSUBSCRIBE = "OBS.UNSUBSCRIBE" as const;
export const OBS_METHOD_PING = "OBS.PING" as const;

export const OBS_EVENT_SNAPSHOT = "OBS.SNAPSHOT" as const;
export const OBS_EVENT_EVENT = "OBS.EVENT" as const;
export const OBS_EVENT_HEALTH = "OBS.HEALTH" as const;
export const OBS_EVENT_SPEND = "OBS.SPEND" as const;
export const OBS_EVENT_PONG = "OBS.PONG" as const;
export const OBS_EVENT_ERROR = "OBS.ERROR" as const;

export const OBS_STREAM_METHODS = [
  OBS_METHOD_SUBSCRIBE,
  OBS_METHOD_UNSUBSCRIBE,
  OBS_METHOD_PING,
] as const;

export const OBS_STREAM_EVENTS = [
  OBS_EVENT_SNAPSHOT,
  OBS_EVENT_EVENT,
  OBS_EVENT_HEALTH,
  OBS_EVENT_SPEND,
  OBS_EVENT_PONG,
  OBS_EVENT_ERROR,
] as const;

export type ObsDecisionOutcome = "allow" | "deny";

export type ObsFilterInput = {
  agentId?: string;
  eventTypes?: string[];
  modelRefs?: string[];
  decisionOutcome?: ObsDecisionOutcome;
  riskTiers?: string[];
  sinceTs?: number;
};

export type ObsSubscribePayload = {
  schemaVersion: typeof OBS_SCHEMA_VERSION;
  filters?: ObsFilterInput;
  maxEventsPerSec?: number;
};

export type ObsUnsubscribePayload = {
  schemaVersion: typeof OBS_SCHEMA_VERSION;
};

export type ObsPingPayload = {
  schemaVersion: typeof OBS_SCHEMA_VERSION;
};

export type ObsDecision = {
  outcome: ObsDecisionOutcome;
  reason: string;
  ruleId?: string;
};

export type ObsModelMeta = {
  provider?: string;
  modelRef?: string;
  route?: string;
  fromModelRef?: string;
  toModelRef?: string;
  statusCode?: number;
  errorCode?: string;
};

export type ObsToolMeta = {
  toolName?: string;
  toolCallId?: string;
  blocked?: boolean;
};

export type ObsAuditMetrics = {
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  retries?: number;
  fallbackHops?: number;
  toolCalls?: number;
  blockedToolCalls?: number;
};

export type ObsEventRecord = {
  eventId: string;
  schemaVersion: "1.0";
  eventVersion: "1.0";
  timestamp: number;
  traceId: string;
  spanId?: string;
  agentId: string;
  skillId?: string;
  pluginId?: string;
  eventType: string;
  riskTier?: string;
  decision?: ObsDecision;
  model?: ObsModelMeta;
  tool?: ObsToolMeta;
  metrics?: ObsAuditMetrics;
  payload: Record<string, unknown>;
};

export type ObsSnapshotPayload = {
  schemaVersion: typeof OBS_SCHEMA_VERSION;
  events: ObsEventRecord[];
  dropped?: number;
  fromTs?: number;
  toTs?: number;
};

export type ObsEventPayload = {
  schemaVersion: typeof OBS_SCHEMA_VERSION;
  event: ObsEventRecord;
};

export type ObsHealthModelSummary = {
  provider?: string;
  modelRef: string;
  status: "healthy" | "degraded" | "open";
  circuitState: "closed" | "half_open" | "open";
  failureRate: number;
  consecutiveFailures: number;
  totalCalls: number;
  errorCalls: number;
  lastError?: string;
  updatedAt: number;
};

export type ObsFallbackEdgeSummary = {
  fromModelRef: string;
  toModelRef: string;
  count: number;
};

export type ObsHealthPayload = {
  schemaVersion: typeof OBS_SCHEMA_VERSION;
  updatedAt: number;
  models: ObsHealthModelSummary[];
  fallbacks: ObsFallbackEdgeSummary[];
};

export type ObsSpendModelSummary = {
  modelRef: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type ObsSpendAgentSummary = {
  agentId: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type ObsSpendPayload = {
  schemaVersion: typeof OBS_SCHEMA_VERSION;
  updatedAt: number;
  totals: {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  byModel: ObsSpendModelSummary[];
  byAgent: ObsSpendAgentSummary[];
};

export type ObsErrorPayload = {
  schemaVersion: typeof OBS_SCHEMA_VERSION;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export type ObsSubscriptionFilters = {
  agentId?: string;
  eventTypes?: Set<string>;
  modelRefs?: Set<string>;
  decisionOutcome?: ObsDecisionOutcome;
  riskTiers?: Set<string>;
  sinceTs?: number;
};

export function normalizeObsFilters(input?: ObsFilterInput): ObsSubscriptionFilters {
  if (!input) {
    return {};
  }
  const normalizeSet = (value?: string[]): Set<string> | undefined => {
    if (!Array.isArray(value) || value.length === 0) {
      return undefined;
    }
    const entries = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    if (entries.length === 0) {
      return undefined;
    }
    return new Set(entries);
  };
  const normalized: ObsSubscriptionFilters = {};
  if (typeof input.agentId === "string" && input.agentId.trim()) {
    normalized.agentId = input.agentId.trim();
  }
  normalized.eventTypes = normalizeSet(input.eventTypes);
  normalized.modelRefs = normalizeSet(input.modelRefs);
  if (input.decisionOutcome === "allow" || input.decisionOutcome === "deny") {
    normalized.decisionOutcome = input.decisionOutcome;
  }
  normalized.riskTiers = normalizeSet(input.riskTiers);
  if (typeof input.sinceTs === "number" && Number.isFinite(input.sinceTs) && input.sinceTs > 0) {
    normalized.sinceTs = Math.floor(input.sinceTs);
  }
  return normalized;
}

export function eventMatchesObsFilters(
  event: ObsEventRecord,
  filters: ObsSubscriptionFilters | undefined,
): boolean {
  if (!filters) {
    return true;
  }
  if (filters.agentId && event.agentId !== filters.agentId) {
    return false;
  }
  if (filters.sinceTs && event.timestamp < filters.sinceTs) {
    return false;
  }
  if (filters.eventTypes && !filters.eventTypes.has(event.eventType)) {
    return false;
  }
  if (filters.decisionOutcome && event.decision?.outcome !== filters.decisionOutcome) {
    return false;
  }
  if (filters.riskTiers && (!event.riskTier || !filters.riskTiers.has(event.riskTier))) {
    return false;
  }
  if (filters.modelRefs) {
    const modelRefs = [event.model?.modelRef, event.model?.fromModelRef, event.model?.toModelRef]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    if (modelRefs.length === 0) {
      return false;
    }
    if (!modelRefs.some((value) => filters.modelRefs?.has(value))) {
      return false;
    }
  }
  return true;
}

export function isObsSchemaVersion(value: unknown): value is typeof OBS_SCHEMA_VERSION {
  return value === OBS_SCHEMA_VERSION;
}
