import { createHash } from "node:crypto";
import type { StreamedAuditEvent } from "../../packages/observability/src/index.js";
import type { ObservabilityStreamSettings } from "../infra/observability.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast.js";
import {
  OBS_EVENT_ERROR,
  OBS_EVENT_EVENT,
  OBS_EVENT_HEALTH,
  OBS_EVENT_PONG,
  OBS_EVENT_SNAPSHOT,
  OBS_EVENT_SPEND,
  OBS_SCHEMA_VERSION,
  eventMatchesObsFilters,
  normalizeObsFilters,
  type ObsErrorPayload,
  type ObsEventPayload,
  type ObsEventRecord,
  type ObsHealthPayload,
  type ObsHealthModelSummary,
  type ObsSnapshotPayload,
  type ObsSpendPayload,
  type ObsSubscribePayload,
  type ObsSubscriptionFilters,
} from "../observability/stream-protocol.js";

type StreamBridge = {
  subscribe: (listener: (event: StreamedAuditEvent) => void) => () => void;
  getSnapshot: (params?: { sinceTs?: number; limit?: number }) => {
    events: StreamedAuditEvent[];
    fromTs?: number;
    toTs?: number;
  };
};

type ConnectionSubscription = {
  connId: string;
  filters: ObsSubscriptionFilters;
  maxEventsPerSec: number;
  queue: Array<{ event: string; payload: unknown }>;
  flushing: boolean;
  windowStartMs: number;
  sentInWindow: number;
  dropped: number;
};

type SpendModelBucket = {
  modelRef: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

type SpendAgentBucket = {
  agentId: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

type HealthBucket = {
  modelRef: string;
  provider?: string;
  totalCalls: number;
  errorCalls: number;
  consecutiveFailures: number;
  circuitState: "closed" | "half_open" | "open";
  status: "healthy" | "degraded" | "open";
  lastError?: string;
  updatedAt: number;
};

export type GatewayObservabilityStreamOptions = {
  settings: ObservabilityStreamSettings;
  stream: StreamBridge;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  onDrop: (params: { connId: string; dropped: number; reason: string }) => void;
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function hashPayload(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function toErrorPayload(params: {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}): ObsErrorPayload {
  return {
    schemaVersion: OBS_SCHEMA_VERSION,
    code: params.code,
    message: params.message,
    retryable: params.retryable,
    details: params.details,
  };
}

function normalizeEventId(event: StreamedAuditEvent): string {
  const provided = typeof event.eventId === "string" ? event.eventId.trim() : "";
  if (provided) {
    return provided;
  }
  return createHash("sha256")
    .update(`${event.traceId}:${event.timestamp}:${event.eventType}:${event.agentId}:0`, "utf8")
    .digest("hex");
}

function toObsRecord(event: StreamedAuditEvent): ObsEventRecord {
  return {
    eventId: normalizeEventId(event),
    schemaVersion: event.schemaVersion,
    eventVersion: event.eventVersion,
    timestamp: event.timestamp,
    traceId: event.traceId,
    spanId: event.spanId,
    agentId: event.agentId,
    skillId: event.skillId,
    pluginId: event.pluginId,
    eventType: event.eventType,
    riskTier: event.riskTier,
    decision: event.decision,
    model: event.model,
    tool: event.tool,
    metrics: event.metrics,
    payload: event.payload,
  };
}

export class GatewayObservabilityStream {
  private readonly settings: ObservabilityStreamSettings;
  private readonly stream: StreamBridge;
  private readonly broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  private readonly onDrop: GatewayObservabilityStreamOptions["onDrop"];
  private readonly subscriptions = new Map<string, ConnectionSubscription>();
  private readonly spendByModel = new Map<string, SpendModelBucket>();
  private readonly spendByAgent = new Map<string, SpendAgentBucket>();
  private readonly healthByModel = new Map<string, HealthBucket>();
  private readonly fallbackEdges = new Map<string, number>();
  private spendTotals = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  private unsubscribeStream: (() => void) | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private spendDirty = false;
  private healthDirty = false;

  constructor(options: GatewayObservabilityStreamOptions) {
    this.settings = options.settings;
    this.stream = options.stream;
    this.broadcastToConnIds = options.broadcastToConnIds;
    this.onDrop = options.onDrop;

    const initial = options.stream.getSnapshot({
      sinceTs: Date.now() - this.settings.replayWindowMs,
      limit: this.settings.serverMaxBufferedEvents,
    });
    for (const event of initial.events) {
      this.processMetrics(toObsRecord(event));
    }

    this.unsubscribeStream = options.stream.subscribe((event) => {
      this.handleLiveEvent(toObsRecord(event));
    });

    this.summaryTimer = setInterval(() => {
      this.broadcastSummaries();
    }, 5_000);
    this.summaryTimer.unref?.();
  }

  close() {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
    this.subscriptions.clear();
  }

  removeConnection(connId: string) {
    this.subscriptions.delete(connId);
  }

  private eventBytes(event: string, payload: unknown): number {
    return Buffer.byteLength(JSON.stringify({ type: "event", event, payload }), "utf8");
  }

  private normalizePayload(
    event: string,
    payload: unknown,
  ): { payload: unknown; dropped: boolean } {
    const bytes = this.eventBytes(event, payload);
    if (bytes <= this.settings.messageMaxBytes) {
      return { payload, dropped: false };
    }

    if (event === OBS_EVENT_EVENT) {
      const record = payload as ObsEventPayload;
      const source = record?.event;
      if (source && typeof source === "object") {
        const trimmed: ObsEventPayload = {
          schemaVersion: OBS_SCHEMA_VERSION,
          event: {
            ...source,
            payload: {
              truncated: true,
              payloadBytes: bytes,
              payloadHash: hashPayload(source.payload),
            },
          },
        };
        if (this.eventBytes(event, trimmed) <= this.settings.messageMaxBytes) {
          return { payload: trimmed, dropped: false };
        }
      }
    }

    return { payload, dropped: true };
  }

  private enqueue(connId: string, event: string, payload: unknown) {
    const sub = this.subscriptions.get(connId);
    if (!sub) {
      return;
    }
    const normalized = this.normalizePayload(event, payload);
    if (normalized.dropped) {
      sub.dropped += 1;
      this.onDrop({ connId, dropped: 1, reason: "message_too_large" });
      return;
    }
    if (sub.queue.length >= this.settings.serverMaxBufferedEvents) {
      sub.queue.shift();
      sub.dropped += 1;
    }
    sub.queue.push({ event, payload: normalized.payload });
    this.scheduleFlush(sub);
  }

  private send(connId: string, event: string, payload: unknown) {
    this.broadcastToConnIds(event, payload, new Set([connId]), { dropIfSlow: true });
  }

  private scheduleFlush(sub: ConnectionSubscription) {
    if (sub.flushing) {
      return;
    }
    sub.flushing = true;
    queueMicrotask(() => {
      this.flushSubscription(sub.connId);
    });
  }

  private flushSubscription(connId: string) {
    const sub = this.subscriptions.get(connId);
    if (!sub) {
      return;
    }

    const now = Date.now();
    if (now - sub.windowStartMs >= 1_000) {
      sub.windowStartMs = now;
      sub.sentInWindow = 0;
    }

    if (sub.dropped > 0) {
      const dropped = sub.dropped;
      sub.dropped = 0;
      this.send(
        connId,
        OBS_EVENT_ERROR,
        toErrorPayload({
          code: "BUFFER_OVERFLOW",
          message: `Dropped ${dropped} event(s) due to backpressure`,
          retryable: true,
          details: { dropped },
        }),
      );
      this.onDrop({ connId, dropped, reason: "backpressure" });
    }

    while (sub.queue.length > 0 && sub.sentInWindow < sub.maxEventsPerSec) {
      const next = sub.queue.shift();
      if (!next) {
        continue;
      }
      this.send(connId, next.event, next.payload);
      sub.sentInWindow += 1;
    }

    if (sub.queue.length > 0) {
      const waitMs = Math.max(1, 1_000 - (Date.now() - sub.windowStartMs));
      setTimeout(() => {
        this.flushSubscription(connId);
      }, waitMs);
      return;
    }

    sub.flushing = false;
  }

  private parseProvider(modelRef: string | undefined): string | undefined {
    if (!modelRef) {
      return undefined;
    }
    const value = modelRef.trim();
    if (!value) {
      return undefined;
    }
    const slash = value.indexOf("/");
    if (slash <= 0) {
      return undefined;
    }
    return value.slice(0, slash);
  }

  private ensureHealthBucket(modelRef: string, provider?: string): HealthBucket {
    const key = modelRef.trim();
    const existing = this.healthByModel.get(key);
    if (existing) {
      if (!existing.provider && provider) {
        existing.provider = provider;
      }
      return existing;
    }
    const created: HealthBucket = {
      modelRef: key,
      provider,
      totalCalls: 0,
      errorCalls: 0,
      consecutiveFailures: 0,
      circuitState: "closed",
      status: "healthy",
      updatedAt: Date.now(),
    };
    this.healthByModel.set(key, created);
    return created;
  }

  private processMetrics(event: ObsEventRecord) {
    if (event.eventType === "model.call.end") {
      const modelRef = event.model?.modelRef;
      if (typeof modelRef === "string" && modelRef.trim()) {
        const normalizedModelRef = modelRef.trim();
        const tokensIn = Math.max(0, Math.floor(event.metrics?.tokensIn ?? 0));
        const tokensOut = Math.max(0, Math.floor(event.metrics?.tokensOut ?? 0));
        const costUsd = Math.max(0, Number(event.metrics?.costUsd ?? 0));

        const byModel =
          this.spendByModel.get(normalizedModelRef) ??
          (() => {
            const created: SpendModelBucket = {
              modelRef: normalizedModelRef,
              calls: 0,
              tokensIn: 0,
              tokensOut: 0,
              costUsd: 0,
            };
            this.spendByModel.set(normalizedModelRef, created);
            return created;
          })();
        byModel.calls += 1;
        byModel.tokensIn += tokensIn;
        byModel.tokensOut += tokensOut;
        byModel.costUsd = Number((byModel.costUsd + costUsd).toFixed(8));

        const byAgent =
          this.spendByAgent.get(event.agentId) ??
          (() => {
            const created: SpendAgentBucket = {
              agentId: event.agentId,
              calls: 0,
              tokensIn: 0,
              tokensOut: 0,
              costUsd: 0,
            };
            this.spendByAgent.set(event.agentId, created);
            return created;
          })();
        byAgent.calls += 1;
        byAgent.tokensIn += tokensIn;
        byAgent.tokensOut += tokensOut;
        byAgent.costUsd = Number((byAgent.costUsd + costUsd).toFixed(8));

        this.spendTotals.calls += 1;
        this.spendTotals.tokensIn += tokensIn;
        this.spendTotals.tokensOut += tokensOut;
        this.spendTotals.costUsd = Number((this.spendTotals.costUsd + costUsd).toFixed(8));
        this.spendDirty = true;

        const provider = event.model?.provider ?? this.parseProvider(normalizedModelRef);
        const health = this.ensureHealthBucket(normalizedModelRef, provider);
        health.totalCalls += 1;
        health.consecutiveFailures = 0;
        if (health.circuitState !== "open") {
          health.status = "healthy";
        }
        health.updatedAt = event.timestamp;
        this.healthDirty = true;
      }
      return;
    }

    if (event.eventType === "model.call.error") {
      const modelRef = event.model?.modelRef;
      if (typeof modelRef === "string" && modelRef.trim()) {
        const normalizedModelRef = modelRef.trim();
        const provider = event.model?.provider ?? this.parseProvider(normalizedModelRef);
        const health = this.ensureHealthBucket(normalizedModelRef, provider);
        health.totalCalls += 1;
        health.errorCalls += 1;
        health.consecutiveFailures += 1;
        health.status = health.circuitState === "open" ? "open" : "degraded";
        health.lastError =
          typeof event.payload?.error === "string"
            ? event.payload.error
            : typeof event.payload?.reason === "string"
              ? event.payload.reason
              : health.lastError;
        health.updatedAt = event.timestamp;
        this.healthDirty = true;
      }
      return;
    }

    if (event.eventType === "model.fallback") {
      const fromModelRef = event.model?.fromModelRef;
      const toModelRef = event.model?.toModelRef;
      if (typeof fromModelRef === "string" && typeof toModelRef === "string") {
        const key = `${fromModelRef}->${toModelRef}`;
        this.fallbackEdges.set(key, (this.fallbackEdges.get(key) ?? 0) + 1);
        this.healthDirty = true;
      }
      return;
    }

    if (event.eventType === "health.circuit.state_change") {
      const modelRef = event.model?.modelRef;
      if (typeof modelRef !== "string" || !modelRef.trim()) {
        return;
      }
      const nextState =
        event.payload && typeof event.payload.next === "string" ? event.payload.next : undefined;
      const provider = event.model?.provider ?? this.parseProvider(modelRef);
      const health = this.ensureHealthBucket(modelRef.trim(), provider);
      if (nextState === "open" || nextState === "half_open" || nextState === "closed") {
        health.circuitState = nextState;
      }
      health.status =
        health.circuitState === "open"
          ? "open"
          : health.errorCalls > 0 && health.consecutiveFailures > 0
            ? "degraded"
            : "healthy";
      health.updatedAt = event.timestamp;
      this.healthDirty = true;
    }
  }

  private buildSpendPayload(): ObsSpendPayload {
    return {
      schemaVersion: OBS_SCHEMA_VERSION,
      updatedAt: Date.now(),
      totals: { ...this.spendTotals },
      byModel: [...this.spendByModel.values()].toSorted((a, b) => b.calls - a.calls),
      byAgent: [...this.spendByAgent.values()].toSorted((a, b) => b.calls - a.calls),
    };
  }

  private buildHealthPayload(): ObsHealthPayload {
    const models: ObsHealthModelSummary[] = [...this.healthByModel.values()].map((entry) => ({
      provider: entry.provider,
      modelRef: entry.modelRef,
      status: entry.status,
      circuitState: entry.circuitState,
      failureRate:
        entry.totalCalls > 0 ? Number((entry.errorCalls / entry.totalCalls).toFixed(4)) : 0,
      consecutiveFailures: entry.consecutiveFailures,
      totalCalls: entry.totalCalls,
      errorCalls: entry.errorCalls,
      lastError: entry.lastError,
      updatedAt: entry.updatedAt,
    }));

    const fallbacks = [...this.fallbackEdges.entries()]
      .map(([key, count]) => {
        const arrow = key.indexOf("->");
        if (arrow < 0) {
          return null;
        }
        return {
          fromModelRef: key.slice(0, arrow),
          toModelRef: key.slice(arrow + 2),
          count,
        };
      })
      .filter((value): value is { fromModelRef: string; toModelRef: string; count: number } =>
        Boolean(value),
      )
      .toSorted((a, b) => b.count - a.count);

    return {
      schemaVersion: OBS_SCHEMA_VERSION,
      updatedAt: Date.now(),
      models,
      fallbacks,
    };
  }

  private broadcastSummaries() {
    if (!this.spendDirty && !this.healthDirty) {
      return;
    }
    const connIds = [...this.subscriptions.keys()];
    if (connIds.length === 0) {
      this.spendDirty = false;
      this.healthDirty = false;
      return;
    }
    const spend = this.buildSpendPayload();
    const health = this.buildHealthPayload();
    for (const connId of connIds) {
      this.enqueue(connId, OBS_EVENT_SPEND, spend);
      this.enqueue(connId, OBS_EVENT_HEALTH, health);
    }
    this.spendDirty = false;
    this.healthDirty = false;
  }

  private handleLiveEvent(event: ObsEventRecord) {
    this.processMetrics(event);
    const payload: ObsEventPayload = {
      schemaVersion: OBS_SCHEMA_VERSION,
      event,
    };
    for (const [connId, sub] of this.subscriptions) {
      if (!eventMatchesObsFilters(event, sub.filters)) {
        continue;
      }
      this.enqueue(connId, OBS_EVENT_EVENT, payload);
    }
  }

  private fitSnapshot(events: ObsEventRecord[]): ObsEventRecord[] {
    if (events.length === 0) {
      return events;
    }
    const fitted: ObsEventRecord[] = [];
    for (const event of events) {
      fitted.push(event);
      const candidate: ObsSnapshotPayload = {
        schemaVersion: OBS_SCHEMA_VERSION,
        events: fitted,
      };
      if (this.eventBytes(OBS_EVENT_SNAPSHOT, candidate) <= this.settings.messageMaxBytes) {
        continue;
      }
      fitted.pop();
      break;
    }
    return fitted;
  }

  subscribe(
    connId: string,
    payload: ObsSubscribePayload,
  ): {
    snapshot: ObsSnapshotPayload;
    health: ObsHealthPayload;
    spend: ObsSpendPayload;
  } {
    const filters = normalizeObsFilters(payload.filters);
    const maxEventsPerSec = clamp(
      Number(payload.maxEventsPerSec ?? this.settings.serverMaxEventsPerSec),
      1,
      this.settings.serverMaxEventsPerSec,
    );

    this.subscriptions.set(connId, {
      connId,
      filters,
      maxEventsPerSec,
      queue: [],
      flushing: false,
      windowStartMs: Date.now(),
      sentInWindow: 0,
      dropped: 0,
    });

    const snapshotSource = this.settings.replayWindowMs;
    const sinceTs =
      typeof filters.sinceTs === "number" ? filters.sinceTs : Date.now() - snapshotSource;
    const replay = this.settings.serverMaxBufferedEvents;
    const raw = this.getFilteredSnapshot({ connId, sinceTs, limit: replay });
    const fitted = this.fitSnapshot(raw.events);

    return {
      snapshot: {
        schemaVersion: OBS_SCHEMA_VERSION,
        events: fitted,
        fromTs: fitted[0]?.timestamp,
        toTs: fitted[fitted.length - 1]?.timestamp,
      },
      health: this.buildHealthPayload(),
      spend: this.buildSpendPayload(),
    };
  }

  sendInitial(
    connId: string,
    initial: { snapshot: ObsSnapshotPayload; health: ObsHealthPayload; spend: ObsSpendPayload },
  ) {
    this.enqueue(connId, OBS_EVENT_SNAPSHOT, initial.snapshot);
    this.enqueue(connId, OBS_EVENT_HEALTH, initial.health);
    this.enqueue(connId, OBS_EVENT_SPEND, initial.spend);
  }

  private getFilteredSnapshot(params: { connId: string; sinceTs: number; limit: number }): {
    events: ObsEventRecord[];
  } {
    const sub = this.subscriptions.get(params.connId);
    if (!sub) {
      return { events: [] };
    }
    const snapshot = sub.filters;
    const replay = Math.min(params.limit, this.settings.serverMaxBufferedEvents);

    // Pull from ring buffer and then filter server-side.
    // Keep this small enough to satisfy message size + replay window constraints.
    const bridgeEvents = this.stream.getSnapshot({
      sinceTs: params.sinceTs,
      limit: replay,
    }).events;
    const filtered = bridgeEvents
      .map((event) => toObsRecord(event))
      .filter((event) => eventMatchesObsFilters(event, snapshot));
    return {
      events: filtered,
    };
  }

  unsubscribe(connId: string) {
    this.subscriptions.delete(connId);
  }

  ping(connId: string) {
    this.send(connId, OBS_EVENT_PONG, {
      schemaVersion: OBS_SCHEMA_VERSION,
      ts: Date.now(),
    });
  }

  notifyError(
    connId: string,
    params: { code: string; message: string; details?: Record<string, unknown> },
  ) {
    this.send(
      connId,
      OBS_EVENT_ERROR,
      toErrorPayload({
        code: params.code,
        message: params.message,
        details: params.details,
      }),
    );
  }
}
