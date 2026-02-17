import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  AuditLogger,
  CompositeAuditSink,
  createRootTrace,
  HealthTracker,
  JsonlAuditSink,
  SpendTracker,
  StreamAuditSink,
  type AuditSink,
  type AuditEventInput,
  type StreamAuditSnapshot,
  type StreamAuditSnapshotParams,
  type StreamedAuditEvent,
} from "../../packages/observability/src/index.js";

type AgentEventLike = {
  runId: string;
  stream: string;
  ts?: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

type RequestState = {
  requestId: string;
  traceId: string;
  spanId: string;
  agentId: string;
  startedAt: number;
  toolCalls: number;
  blockedToolCalls: number;
  fallbackHops: number;
  retries: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  delegationCalls: number;
  delegationMessages: number;
  artifactsPublished: number;
  artifactsFetched: number;
};

type ObservabilityRuntime = {
  enabled: boolean;
  debug: boolean;
  auditDir: string;
  spendDir: string;
  streamEnabled: boolean;
  streamReplayWindowMs: number;
  streamServerMaxEventsPerSec: number;
  streamServerMaxBufferedEvents: number;
  streamMessageMaxBytes: number;
  stream?: StreamAuditSink;
  audit: AuditLogger;
  spend: SpendTracker;
  health: HealthTracker;
  requestStateById: Map<string, RequestState>;
};

export type ObservabilityStreamSettings = {
  enabled: boolean;
  replayWindowMs: number;
  serverMaxEventsPerSec: number;
  serverMaxBufferedEvents: number;
  messageMaxBytes: number;
};

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "openclaw-data");
const DEFAULT_AUDIT_DIR = path.join(DEFAULT_DATA_DIR, "audit");
const DEFAULT_SPEND_DIR = path.join(DEFAULT_DATA_DIR, "spend");
const DEFAULT_STREAM_REPLAY_WINDOW_MS = 300_000;
const DEFAULT_STREAM_MAX_EVENTS_PER_SEC = 50;
const DEFAULT_STREAM_MAX_BUFFERED_EVENTS = 10_000;
const DEFAULT_STREAM_MESSAGE_MAX_BYTES = 65_536;

let runtime: ObservabilityRuntime | null = null;
let runtimeConfigKey = "";

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? path.resolve(value) : fallback;
}

function streamEnabled(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return process.env.NODE_ENV !== "production";
}

function eventPhase(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorText(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "unserializable error";
  }
}

function getProviderModelRef(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function parsePricing(
  config: OpenClawConfig | undefined,
): Record<string, { inputPer1kUsd?: number; outputPer1kUsd?: number }> | undefined {
  const pricing = config?.observability?.spend?.pricing;
  if (!pricing || typeof pricing !== "object") {
    return undefined;
  }
  return pricing;
}

function buildRuntime(config?: OpenClawConfig): ObservabilityRuntime {
  const observability = config?.observability;
  const enabled = bool(observability?.enabled, false);
  const debug = bool(observability?.debug, false);
  const redactionMode = observability?.redactionMode === "debug" ? "debug" : "strict";
  const auditEnabled = enabled && bool(observability?.audit?.enabled, true);
  const spendEnabled = enabled && bool(observability?.spend?.enabled, true);
  const healthEnabled = enabled && bool(observability?.health?.enabled, true);
  const streamFeatureEnabled = enabled && streamEnabled(observability?.stream?.enabled);
  const streamReplayWindowMs = num(
    observability?.stream?.replayWindowMs,
    DEFAULT_STREAM_REPLAY_WINDOW_MS,
  );
  const streamServerMaxEventsPerSec = num(
    observability?.stream?.serverMaxEventsPerSec,
    DEFAULT_STREAM_MAX_EVENTS_PER_SEC,
  );
  const streamServerMaxBufferedEvents = num(
    observability?.stream?.serverMaxBufferedEvents,
    DEFAULT_STREAM_MAX_BUFFERED_EVENTS,
  );
  const streamMessageMaxBytes = num(
    observability?.stream?.messageMaxBytes,
    DEFAULT_STREAM_MESSAGE_MAX_BYTES,
  );

  const auditDir = text(observability?.audit?.dir, DEFAULT_AUDIT_DIR);
  const spendDir = text(observability?.spend?.dir, DEFAULT_SPEND_DIR);
  const stream = streamFeatureEnabled
    ? new StreamAuditSink({
        maxBufferedEvents: streamServerMaxBufferedEvents,
        replayWindowMs: streamReplayWindowMs,
      })
    : undefined;

  const sinks: AuditSink[] = [];
  if (auditEnabled) {
    sinks.push(
      new JsonlAuditSink({
        dir: auditDir,
        maxPayloadBytes: num(observability?.audit?.maxPayloadBytes, 262_144),
      }),
    );
  }
  if (stream) {
    sinks.push(stream);
  }

  const sink =
    sinks.length === 0
      ? {
          write: () => {},
        }
      : sinks.length === 1
        ? sinks[0]
        : new CompositeAuditSink(sinks);

  const audit = new AuditLogger({
    enabled: enabled && sinks.length > 0,
    sink,
    maxQueueSize: num(observability?.audit?.maxQueueSize, 10_000),
    redaction: {
      mode: redactionMode,
      maxDebugStringChars: debug ? 2_048 : 512,
    },
  });

  const spend = new SpendTracker({
    enabled: spendEnabled,
    dir: spendDir,
    summaryPath: observability?.spend?.summaryPath
      ? path.resolve(observability.spend.summaryPath)
      : path.join(spendDir, "summary.json"),
    pricingTable: parsePricing(config),
  });

  const health = new HealthTracker({
    failureThreshold: num(observability?.health?.failureThreshold, 3),
    windowMs: num(observability?.health?.windowMs, 60_000),
    openMs: num(observability?.health?.openMs, 60_000),
  });

  const built: ObservabilityRuntime = {
    enabled,
    debug,
    auditDir,
    spendDir,
    streamEnabled: streamFeatureEnabled,
    streamReplayWindowMs,
    streamServerMaxEventsPerSec,
    streamServerMaxBufferedEvents,
    streamMessageMaxBytes,
    stream,
    audit,
    spend,
    health,
    requestStateById: new Map(),
  };

  if (enabled) {
    if (auditEnabled) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
    if (spendEnabled) {
      fs.mkdirSync(spendDir, { recursive: true });
    }
  }

  if (enabled && healthEnabled) {
    health.onStateChange((event) => {
      audit.emit({
        traceId: createRootTrace().traceId,
        agentId: "system",
        eventType: "health.circuit.state_change",
        model: {
          provider: event.provider,
          modelRef: event.modelRef,
        },
        payload: {
          previous: event.previous,
          next: event.next,
          reason: event.reason,
        },
      });
    });
  }

  return built;
}

function configKey(config?: OpenClawConfig): string {
  return JSON.stringify(config?.observability ?? {});
}

function ensureRuntime(config?: OpenClawConfig): ObservabilityRuntime {
  const nextKey = configKey(config);
  if (!runtime || runtimeConfigKey !== nextKey) {
    runtime = buildRuntime(config);
    runtimeConfigKey = nextKey;
  }
  return runtime;
}

function resolveAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const match = /^agent:([^:]+)/.exec(sessionKey.trim());
  return match?.[1];
}

function ensureRequestState(params: {
  rt: ObservabilityRuntime;
  requestId: string;
  agentId?: string;
  ts?: number;
}): RequestState {
  const existing = params.rt.requestStateById.get(params.requestId);
  if (existing) {
    return existing;
  }
  const root = createRootTrace({ requestId: params.requestId, agentId: params.agentId });
  const created: RequestState = {
    requestId: params.requestId,
    traceId: root.traceId,
    spanId: root.spanId,
    agentId: params.agentId?.trim() || "main",
    startedAt: params.ts ?? Date.now(),
    toolCalls: 0,
    blockedToolCalls: 0,
    fallbackHops: 0,
    retries: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    delegationCalls: 0,
    delegationMessages: 0,
    artifactsPublished: 0,
    artifactsFetched: 0,
  };
  params.rt.requestStateById.set(params.requestId, created);
  return created;
}

function findRequestStateByTraceId(rt: ObservabilityRuntime, traceId: string): RequestState | null {
  const trimmed = traceId.trim();
  if (!trimmed) {
    return null;
  }
  for (const state of rt.requestStateById.values()) {
    if (state.traceId === trimmed) {
      return state;
    }
  }
  return null;
}

function resolveDelegationState(params: {
  rt: ObservabilityRuntime;
  requestId?: string;
  traceId?: string;
  agentId?: string;
}): RequestState | null {
  const requestId = params.requestId?.trim();
  if (requestId) {
    return ensureRequestState({
      rt: params.rt,
      requestId,
      agentId: params.agentId,
    });
  }
  const traceId = params.traceId?.trim();
  if (traceId) {
    return findRequestStateByTraceId(params.rt, traceId);
  }
  return null;
}

function emitAudit(rt: ObservabilityRuntime, input: AuditEventInput) {
  if (!rt.enabled) {
    return;
  }
  rt.audit.emit(input);
}

export function observeAgentEvent(event: AgentEventLike, config?: OpenClawConfig) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }

  if (event.stream === "lifecycle") {
    const phase = eventPhase(event.data.phase);
    const agentId =
      (typeof event.data.agentId === "string" ? event.data.agentId : undefined) ??
      resolveAgentIdFromSessionKey(event.sessionKey) ??
      "main";

    if (phase === "start") {
      const state = ensureRequestState({ rt, requestId: event.runId, agentId, ts: event.ts });
      emitAudit(rt, {
        traceId: state.traceId,
        spanId: state.spanId,
        agentId: state.agentId,
        eventType: "request.start",
        payload: {
          requestId: event.runId,
          sessionKey: event.sessionKey,
        },
      });
      return;
    }

    if (phase === "end" || phase === "error") {
      const state = ensureRequestState({ rt, requestId: event.runId, agentId, ts: event.ts });
      const endedAt = typeof event.data.endedAt === "number" ? event.data.endedAt : Date.now();
      emitAudit(rt, {
        traceId: state.traceId,
        spanId: state.spanId,
        agentId: state.agentId,
        eventType: "request.end",
        metrics: {
          latencyMs: Math.max(0, endedAt - state.startedAt),
          toolCalls: state.toolCalls,
          blockedToolCalls: state.blockedToolCalls,
          fallbackHops: state.fallbackHops,
          retries: state.retries,
          tokensIn: state.tokensIn || undefined,
          tokensOut: state.tokensOut || undefined,
          costUsd: state.costUsd || undefined,
          delegationCalls: state.delegationCalls || undefined,
          delegationMessages: state.delegationMessages || undefined,
          artifactsPublished: state.artifactsPublished || undefined,
          artifactsFetched: state.artifactsFetched || undefined,
        },
        payload: {
          requestId: event.runId,
          status: phase === "error" ? "error" : "ok",
          error: phase === "error" ? (event.data.error ?? "unknown") : undefined,
        },
      });
      rt.requestStateById.delete(event.runId);
    }
    return;
  }

  if (event.stream === "tool") {
    const phase = eventPhase(event.data.phase);
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey) ?? "main";
    const state = ensureRequestState({ rt, requestId: event.runId, agentId, ts: event.ts });
    const toolName = typeof event.data.name === "string" ? event.data.name : undefined;
    const toolCallId =
      typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;

    if (phase === "start") {
      state.toolCalls += 1;
      emitAudit(rt, {
        traceId: state.traceId,
        spanId: state.spanId,
        agentId: state.agentId,
        eventType: "tool.call.start",
        tool: {
          toolName,
          toolCallId,
        },
        payload: {},
      });
      return;
    }

    if (phase === "blocked") {
      state.toolCalls += 1;
      state.blockedToolCalls += 1;
      emitAudit(rt, {
        traceId: state.traceId,
        spanId: state.spanId,
        agentId: state.agentId,
        eventType: "tool.call.start",
        tool: {
          toolName,
          toolCallId,
        },
        payload: { blocked: true },
      });
      emitAudit(rt, {
        traceId: state.traceId,
        spanId: state.spanId,
        agentId: state.agentId,
        eventType: "tool.call.blocked",
        tool: {
          toolName,
          toolCallId,
          blocked: true,
        },
        decision: {
          outcome: "deny",
          reason:
            typeof event.data.reason === "string" ? event.data.reason : "blocked by policy or hook",
        },
        payload: {
          blocked: true,
        },
      });
      return;
    }

    if (phase === "result") {
      const isError = event.data.isError === true;
      emitAudit(rt, {
        traceId: state.traceId,
        spanId: state.spanId,
        agentId: state.agentId,
        eventType: isError ? "tool.call.error" : "tool.call.end",
        tool: {
          toolName,
          toolCallId,
          blocked: false,
        },
        payload: {
          isError,
        },
      });
    }
  }
}

export function observeModelCallStart(
  params: {
    requestId: string;
    provider: string;
    model: string;
    agentId?: string;
    attempt?: number;
    total?: number;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = ensureRequestState({
    rt,
    requestId: params.requestId,
    agentId: params.agentId,
  });

  emitAudit(rt, {
    traceId: state.traceId,
    spanId: state.spanId,
    agentId: state.agentId,
    eventType: "model.call.start",
    model: {
      provider: params.provider,
      modelRef: getProviderModelRef(params.provider, params.model),
    },
    payload: {
      attempt: params.attempt,
      total: params.total,
    },
  });
}

export function observeModelCallError(
  params: {
    requestId: string;
    provider: string;
    model: string;
    reason?: string;
    statusCode?: number;
    errorCode?: string;
    error?: unknown;
    agentId?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = ensureRequestState({ rt, requestId: params.requestId, agentId: params.agentId });
  state.retries += 1;

  emitAudit(rt, {
    traceId: state.traceId,
    spanId: state.spanId,
    agentId: state.agentId,
    eventType: "model.call.error",
    model: {
      provider: params.provider,
      modelRef: getProviderModelRef(params.provider, params.model),
      statusCode: params.statusCode,
      errorCode: params.errorCode,
    },
    payload: {
      reason: params.reason,
      error: errorText(params.error),
    },
  });

  rt.health.noteFailure(
    params.provider,
    getProviderModelRef(params.provider, params.model),
    params.reason,
  );
}

export function observeModelCallFallback(
  params: {
    requestId: string;
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    reason?: string;
    agentId?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = ensureRequestState({ rt, requestId: params.requestId, agentId: params.agentId });
  state.fallbackHops += 1;
  emitAudit(rt, {
    traceId: state.traceId,
    spanId: state.spanId,
    agentId: state.agentId,
    eventType: "model.fallback",
    model: {
      provider: params.fromProvider,
      fromModelRef: getProviderModelRef(params.fromProvider, params.fromModel),
      toModelRef: getProviderModelRef(params.toProvider, params.toModel),
    },
    payload: {
      reason: params.reason,
    },
  });
}

export function observeModelCallEnd(
  params: {
    requestId: string;
    provider: string;
    model: string;
    tokensIn?: number;
    tokensOut?: number;
    latencyMs?: number;
    agentId?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }

  const state = ensureRequestState({ rt, requestId: params.requestId, agentId: params.agentId });
  const modelRef = getProviderModelRef(params.provider, params.model);
  const spend = rt.spend.recordCall({
    timestamp: Date.now(),
    agentId: state.agentId,
    modelRef,
    tokensIn: params.tokensIn,
    tokensOut: params.tokensOut,
    traceId: state.traceId,
  });

  state.tokensIn += spend.tokensIn ?? 0;
  state.tokensOut += spend.tokensOut ?? 0;
  state.costUsd = Number((state.costUsd + (spend.costUsd ?? 0)).toFixed(8));

  emitAudit(rt, {
    traceId: state.traceId,
    spanId: state.spanId,
    agentId: state.agentId,
    eventType: "model.call.end",
    model: {
      provider: params.provider,
      modelRef,
    },
    metrics: {
      latencyMs: params.latencyMs,
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      costUsd: spend.costUsd,
      retries: state.retries,
      fallbackHops: state.fallbackHops,
    },
    payload: {},
  });

  rt.health.noteSuccess(params.provider, modelRef);
}

export function observePluginLifecycle(
  params: {
    eventType: "plugin.load" | "plugin.error" | "plugin.disabled";
    pluginId: string;
    reason?: string;
    payload?: Record<string, unknown>;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const trace = createRootTrace({ agentId: "system" });
  emitAudit(rt, {
    traceId: trace.traceId,
    spanId: trace.spanId,
    agentId: "system",
    pluginId: params.pluginId,
    eventType: params.eventType,
    payload: {
      reason: params.reason,
      ...params.payload,
    },
  });
}

export function observeSkillLifecycle(
  params: {
    eventType: "skill.load" | "skill.disabled";
    skillId: string;
    agentId?: string;
    reason?: string;
    payload?: Record<string, unknown>;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const trace = createRootTrace({ agentId: params.agentId });
  emitAudit(rt, {
    traceId: trace.traceId,
    spanId: trace.spanId,
    agentId: params.agentId ?? "main",
    skillId: params.skillId,
    eventType: params.eventType,
    payload: {
      reason: params.reason,
      ...params.payload,
    },
  });
}

export function observeToolCallBlocked(
  params: {
    runId?: string;
    toolName: string;
    toolCallId?: string;
    reason: string;
    agentId?: string;
    sessionKey?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const requestId = params.runId?.trim() || `tool-${Date.now()}`;
  const state = ensureRequestState({ rt, requestId, agentId: params.agentId });
  state.toolCalls += 1;
  state.blockedToolCalls += 1;
  emitAudit(rt, {
    traceId: state.traceId,
    spanId: state.spanId,
    agentId: state.agentId,
    eventType: "tool.call.start",
    tool: {
      toolName: params.toolName,
      toolCallId: params.toolCallId,
    },
    payload: {
      blocked: true,
      sessionKey: params.sessionKey,
    },
  });
  emitAudit(rt, {
    traceId: state.traceId,
    spanId: state.spanId,
    agentId: state.agentId,
    eventType: "tool.call.blocked",
    tool: {
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      blocked: true,
    },
    decision: {
      outcome: "deny",
      reason: params.reason,
    },
    payload: {
      blocked: true,
      sessionKey: params.sessionKey,
    },
  });
}

export function getObservabilityPaths(config?: OpenClawConfig): {
  auditDir: string;
  spendDir: string;
} {
  const rt = ensureRuntime(config);
  return {
    auditDir: rt.auditDir,
    spendDir: rt.spendDir,
  };
}

export function getObservabilityStreamSettings(
  config?: OpenClawConfig,
): ObservabilityStreamSettings {
  const rt = ensureRuntime(config);
  return {
    enabled: rt.streamEnabled,
    replayWindowMs: rt.streamReplayWindowMs,
    serverMaxEventsPerSec: rt.streamServerMaxEventsPerSec,
    serverMaxBufferedEvents: rt.streamServerMaxBufferedEvents,
    messageMaxBytes: rt.streamMessageMaxBytes,
  };
}

export function getObservabilityEventStream(config?: OpenClawConfig): {
  settings: ObservabilityStreamSettings;
  subscribe: (listener: (event: StreamedAuditEvent) => void) => () => void;
  getSnapshot: (params?: StreamAuditSnapshotParams) => StreamAuditSnapshot;
} | null {
  const rt = ensureRuntime(config);
  if (!rt.streamEnabled || !rt.stream) {
    return null;
  }
  return {
    settings: getObservabilityStreamSettings(config),
    subscribe: (listener) => rt.stream?.subscribe(listener) ?? (() => {}),
    getSnapshot: (params) => rt.stream?.getSnapshot(params) ?? { events: [] },
  };
}

export function observeObsDrop(
  params: {
    connId: string;
    dropped: number;
    reason: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const trace = createRootTrace({ agentId: "system" });
  emitAudit(rt, {
    traceId: trace.traceId,
    spanId: trace.spanId,
    agentId: "system",
    eventType: "obs.drop",
    payload: {
      connId: params.connId,
      dropped: params.dropped,
      reason: params.reason,
    },
  });
}

export function observeRoutingDecision(
  params: {
    traceId: string;
    fromAgentId?: string;
    selectedAgentId: string;
    account: string;
    channel: string;
    peer?: string;
    ruleId?: string;
    specificity: number;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const effectiveTraceId = params.traceId.trim() || createRootTrace().traceId;
  const trace = createRootTrace({
    agentId: params.selectedAgentId || params.fromAgentId || "main",
  });
  emitAudit(rt, {
    traceId: effectiveTraceId,
    spanId: trace.spanId,
    agentId: params.selectedAgentId || params.fromAgentId || "main",
    eventType: "routing.decision",
    payload: {
      fromAgentId: params.fromAgentId,
      selectedAgentId: params.selectedAgentId,
      account: params.account,
      channel: params.channel,
      peer: params.peer,
      ruleId: params.ruleId,
      specificity: params.specificity,
    },
  });
}

export function observeAgentMessage(
  params: {
    traceId: string;
    fromAgentId: string;
    toAgentId: string;
    sessionKey: string;
    artifactIds?: string[];
    requestId?: string;
    priority?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = resolveDelegationState({
    rt,
    requestId: params.requestId,
    traceId: params.traceId,
    agentId: params.fromAgentId,
  });
  if (state) {
    state.delegationMessages += 1;
  }
  const effectiveTraceId = (state?.traceId ?? params.traceId.trim()) || createRootTrace().traceId;
  const trace = createRootTrace({
    agentId: params.fromAgentId,
  });
  emitAudit(rt, {
    traceId: effectiveTraceId,
    spanId: trace.spanId,
    agentId: params.fromAgentId,
    eventType: "agent.message",
    payload: {
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      sessionKey: params.sessionKey,
      artifactIds: params.artifactIds ?? [],
      priority: params.priority,
    },
  });
}

export function observeAgentCallStart(
  params: {
    traceId: string;
    fromAgentId: string;
    toAgentId: string;
    sessionKey: string;
    limits: Record<string, unknown>;
    taskHash: string;
    requestId?: string;
    artifactIds?: string[];
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = resolveDelegationState({
    rt,
    requestId: params.requestId,
    traceId: params.traceId,
    agentId: params.fromAgentId,
  });
  if (state) {
    state.delegationCalls += 1;
  }
  const effectiveTraceId = (state?.traceId ?? params.traceId.trim()) || createRootTrace().traceId;
  const trace = createRootTrace({
    agentId: params.fromAgentId,
  });
  emitAudit(rt, {
    traceId: effectiveTraceId,
    spanId: trace.spanId,
    agentId: params.fromAgentId,
    eventType: "agent.call.start",
    payload: {
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      sessionKey: params.sessionKey,
      limits: params.limits,
      taskHash: params.taskHash,
      artifactIds: params.artifactIds ?? [],
    },
  });
}

export function observeAgentCallEnd(
  params: {
    traceId: string;
    fromAgentId: string;
    toAgentId: string;
    sessionKey: string;
    taskHash: string;
    status: string;
    latencyMs?: number;
    artifactIds?: string[];
    requestId?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = resolveDelegationState({
    rt,
    requestId: params.requestId,
    traceId: params.traceId,
    agentId: params.fromAgentId,
  });
  const effectiveTraceId = (state?.traceId ?? params.traceId.trim()) || createRootTrace().traceId;
  const trace = createRootTrace({
    agentId: params.fromAgentId,
  });
  emitAudit(rt, {
    traceId: effectiveTraceId,
    spanId: trace.spanId,
    agentId: params.fromAgentId,
    eventType: "agent.call.end",
    metrics: {
      latencyMs: params.latencyMs,
    },
    payload: {
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      sessionKey: params.sessionKey,
      taskHash: params.taskHash,
      status: params.status,
      artifactIds: params.artifactIds ?? [],
    },
  });
}

export function observeAgentCallError(
  params: {
    traceId: string;
    fromAgentId: string;
    toAgentId: string;
    sessionKey: string;
    taskHash: string;
    error: string;
    requestId?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = resolveDelegationState({
    rt,
    requestId: params.requestId,
    traceId: params.traceId,
    agentId: params.fromAgentId,
  });
  const effectiveTraceId = (state?.traceId ?? params.traceId.trim()) || createRootTrace().traceId;
  const trace = createRootTrace({
    agentId: params.fromAgentId,
  });
  emitAudit(rt, {
    traceId: effectiveTraceId,
    spanId: trace.spanId,
    agentId: params.fromAgentId,
    eventType: "agent.call.error",
    payload: {
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      sessionKey: params.sessionKey,
      taskHash: params.taskHash,
      error: params.error,
    },
  });
}

export function observeArtifactPublish(
  params: {
    traceId: string;
    agentId: string;
    artifactId: string;
    kind: string;
    sizeBytes: number;
    requestId?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = resolveDelegationState({
    rt,
    requestId: params.requestId,
    traceId: params.traceId,
    agentId: params.agentId,
  });
  if (state) {
    state.artifactsPublished += 1;
  }
  const effectiveTraceId = (state?.traceId ?? params.traceId.trim()) || createRootTrace().traceId;
  const trace = createRootTrace({
    agentId: params.agentId,
  });
  emitAudit(rt, {
    traceId: effectiveTraceId,
    spanId: trace.spanId,
    agentId: params.agentId,
    eventType: "artifact.publish",
    payload: {
      artifactId: params.artifactId,
      kind: params.kind,
      sizeBytes: params.sizeBytes,
    },
  });
}

export function observeArtifactFetch(
  params: {
    traceId: string;
    agentId: string;
    artifactId: string;
    requestId?: string;
  },
  config?: OpenClawConfig,
) {
  const rt = ensureRuntime(config);
  if (!rt.enabled) {
    return;
  }
  const state = resolveDelegationState({
    rt,
    requestId: params.requestId,
    traceId: params.traceId,
    agentId: params.agentId,
  });
  if (state) {
    state.artifactsFetched += 1;
  }
  const effectiveTraceId = (state?.traceId ?? params.traceId.trim()) || createRootTrace().traceId;
  const trace = createRootTrace({
    agentId: params.agentId,
  });
  emitAudit(rt, {
    traceId: effectiveTraceId,
    spanId: trace.spanId,
    agentId: params.agentId,
    eventType: "artifact.fetch",
    payload: {
      artifactId: params.artifactId,
    },
  });
}

export async function emitObservabilityTestEvent(config?: OpenClawConfig): Promise<string> {
  const rt = ensureRuntime(config);
  const testId = `obs-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const trace = createRootTrace({ agentId: "system" });
  emitAudit(rt, {
    traceId: trace.traceId,
    spanId: trace.spanId,
    agentId: "system",
    eventType: "observability.verify",
    payload: {
      testId,
    },
  });
  await rt.audit.flush();
  return testId;
}

export async function flushObservability(config?: OpenClawConfig): Promise<void> {
  const rt = ensureRuntime(config);
  await rt.audit.flush();
  await rt.spend.flush();
}

export async function closeObservability(config?: OpenClawConfig): Promise<void> {
  const rt = ensureRuntime(config);
  await rt.audit.close();
  await rt.spend.flush();
}

export function resetObservabilityForTests() {
  runtime = null;
  runtimeConfigKey = "";
}
