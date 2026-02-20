import type {
  ObsDecisionOutcome,
  ObsEventRecord,
  ObsHealthPayload,
  ObsSpendPayload,
} from "../../../src/observability/stream-protocol.js";

export type AuditFilterState = {
  agentId?: string;
  eventType?: string;
  decisionOutcome?: ObsDecisionOutcome;
  modelRef?: string;
  riskTier?: string;
  query?: string;
};

export type SpendWindow = "15m" | "1h" | "today";

export type DerivedSpend = {
  totals: {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  byModel: Array<{
    modelRef: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }>;
  byAgent: Array<{
    agentId: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }>;
};

export function matchesAuditFilter(event: ObsEventRecord, filter: AuditFilterState): boolean {
  if (filter.agentId && event.agentId !== filter.agentId) {
    return false;
  }
  if (filter.eventType && event.eventType !== filter.eventType) {
    return false;
  }
  if (filter.decisionOutcome && event.decision?.outcome !== filter.decisionOutcome) {
    return false;
  }
  if (filter.riskTier && event.riskTier !== filter.riskTier) {
    return false;
  }
  if (filter.modelRef) {
    const refs = [event.model?.modelRef, event.model?.fromModelRef, event.model?.toModelRef]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    if (!refs.includes(filter.modelRef)) {
      return false;
    }
  }
  if (filter.query) {
    const query = filter.query.trim().toLowerCase();
    if (query) {
      const haystack = [
        event.eventType,
        event.traceId,
        event.model?.modelRef,
        event.model?.fromModelRef,
        event.model?.toModelRef,
        event.tool?.toolName,
      ]
        .map((value) => (typeof value === "string" ? value.toLowerCase() : ""))
        .join(" ");
      if (!haystack.includes(query)) {
        return false;
      }
    }
  }
  return true;
}

export function groupTraceEvents(events: ObsEventRecord[], traceId: string): ObsEventRecord[] {
  return events
    .filter((event) => event.traceId === traceId)
    .toSorted((a, b) => a.timestamp - b.timestamp);
}

function resolveWindowStart(window: SpendWindow, now = Date.now()): number {
  if (window === "15m") {
    return now - 15 * 60_000;
  }
  if (window === "1h") {
    return now - 60 * 60_000;
  }
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export class ObservabilityStore {
  private readonly maxEvents: number;
  private readonly events: ObsEventRecord[] = [];
  private readonly eventIds = new Set<string>();
  private lastHealth: ObsHealthPayload | null = null;
  private lastSpend: ObsSpendPayload | null = null;

  constructor(maxEvents = 10_000) {
    this.maxEvents = Math.max(100, maxEvents);
  }

  addEvent(event: ObsEventRecord): boolean {
    if (this.eventIds.has(event.eventId)) {
      return false;
    }
    this.events.push(event);
    this.eventIds.add(event.eventId);
    while (this.events.length > this.maxEvents) {
      const oldest = this.events.shift();
      if (!oldest) {
        break;
      }
      this.eventIds.delete(oldest.eventId);
    }
    return true;
  }

  addEvents(events: ObsEventRecord[]): number {
    let added = 0;
    for (const event of events) {
      if (this.addEvent(event)) {
        added += 1;
      }
    }
    return added;
  }

  setHealth(payload: ObsHealthPayload) {
    this.lastHealth = payload;
  }

  setSpend(payload: ObsSpendPayload) {
    this.lastSpend = payload;
  }

  getHealth(): ObsHealthPayload | null {
    return this.lastHealth;
  }

  getSpendSummary(): ObsSpendPayload | null {
    return this.lastSpend;
  }

  getAllEvents(): ObsEventRecord[] {
    return [...this.events].toSorted((a, b) => b.timestamp - a.timestamp);
  }

  getFilteredEvents(filter: AuditFilterState): ObsEventRecord[] {
    return this.getAllEvents().filter((event) => matchesAuditFilter(event, filter));
  }

  getTrace(traceId: string): ObsEventRecord[] {
    return groupTraceEvents(this.events, traceId);
  }

  deriveSpend(window: SpendWindow, now = Date.now()): DerivedSpend {
    const start = resolveWindowStart(window, now);
    const totals = {
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    const byModel = new Map<
      string,
      { modelRef: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number }
    >();
    const byAgent = new Map<
      string,
      { agentId: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number }
    >();

    for (const event of this.events) {
      if (event.timestamp < start || event.eventType !== "model.call.end") {
        continue;
      }
      const modelRef = event.model?.modelRef ?? "unknown";
      const agentId = event.agentId || "unknown";
      const tokensIn = Math.max(0, Math.floor(event.metrics?.tokensIn ?? 0));
      const tokensOut = Math.max(0, Math.floor(event.metrics?.tokensOut ?? 0));
      const costUsd = Math.max(0, Number(event.metrics?.costUsd ?? 0));

      totals.calls += 1;
      totals.tokensIn += tokensIn;
      totals.tokensOut += tokensOut;
      totals.costUsd = Number((totals.costUsd + costUsd).toFixed(8));

      const model =
        byModel.get(modelRef) ??
        (() => {
          const created = { modelRef, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
          byModel.set(modelRef, created);
          return created;
        })();
      model.calls += 1;
      model.tokensIn += tokensIn;
      model.tokensOut += tokensOut;
      model.costUsd = Number((model.costUsd + costUsd).toFixed(8));

      const agent =
        byAgent.get(agentId) ??
        (() => {
          const created = { agentId, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
          byAgent.set(agentId, created);
          return created;
        })();
      agent.calls += 1;
      agent.tokensIn += tokensIn;
      agent.tokensOut += tokensOut;
      agent.costUsd = Number((agent.costUsd + costUsd).toFixed(8));
    }

    return {
      totals,
      byModel: [...byModel.values()].toSorted((a, b) => b.calls - a.calls),
      byAgent: [...byAgent.values()].toSorted((a, b) => b.calls - a.calls),
    };
  }

  deriveFallbackCounts(
    window: SpendWindow,
    now = Date.now(),
  ): Array<{ fromModelRef: string; toModelRef: string; count: number }> {
    const start = resolveWindowStart(window, now);
    const counts = new Map<string, number>();
    for (const event of this.events) {
      if (event.timestamp < start || event.eventType !== "model.fallback") {
        continue;
      }
      const from = event.model?.fromModelRef;
      const to = event.model?.toModelRef;
      if (typeof from !== "string" || typeof to !== "string") {
        continue;
      }
      const key = `${from}->${to}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([key, count]) => {
        const index = key.indexOf("->");
        if (index < 0) {
          return null;
        }
        return {
          fromModelRef: key.slice(0, index),
          toModelRef: key.slice(index + 2),
          count,
        };
      })
      .filter((value): value is { fromModelRef: string; toModelRef: string; count: number } =>
        Boolean(value),
      )
      .toSorted((a, b) => b.count - a.count);
  }
}
