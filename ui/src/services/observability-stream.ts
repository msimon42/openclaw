import type {
  ObsErrorPayload,
  ObsEventPayload,
  ObsEventRecord,
  ObsFilterInput,
  ObsHealthPayload,
  ObsSnapshotPayload,
  ObsSpendPayload,
} from "../../../src/observability/stream-protocol.js";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../ui/gateway.ts";
import {
  OBS_EVENT_ERROR,
  OBS_EVENT_EVENT,
  OBS_EVENT_HEALTH,
  OBS_EVENT_PONG,
  OBS_EVENT_SNAPSHOT,
  OBS_EVENT_SPEND,
  OBS_METHOD_SUBSCRIBE,
  OBS_METHOD_UNSUBSCRIBE,
  OBS_SCHEMA_VERSION,
} from "../../../src/observability/stream-protocol.js";
import { ObservabilityStore } from "./observability-store.ts";

export type ObservabilityStreamStatus = {
  available: boolean;
  subscribed: boolean;
  lastError: string | null;
  lastSeenTs: number;
};

export type ObservabilityStreamServiceOptions = {
  maxEvents?: number;
  onUpdate: () => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toEventRecord(value: unknown): ObsEventRecord | null {
  if (!isObject(value)) {
    return null;
  }
  if (typeof value.eventId !== "string" || typeof value.eventType !== "string") {
    return null;
  }
  if (typeof value.timestamp !== "number" || typeof value.traceId !== "string") {
    return null;
  }
  if (typeof value.agentId !== "string") {
    return null;
  }
  if (!isObject(value.payload)) {
    return null;
  }
  return value as unknown as ObsEventRecord;
}

function toSnapshot(value: unknown): ObsSnapshotPayload | null {
  if (!isObject(value) || value.schemaVersion !== OBS_SCHEMA_VERSION) {
    return null;
  }
  if (!Array.isArray(value.events)) {
    return null;
  }
  const events = value.events
    .map((entry) => toEventRecord(entry))
    .filter(Boolean) as ObsEventRecord[];
  return {
    schemaVersion: OBS_SCHEMA_VERSION,
    events,
    fromTs: typeof value.fromTs === "number" ? value.fromTs : undefined,
    toTs: typeof value.toTs === "number" ? value.toTs : undefined,
    dropped: typeof value.dropped === "number" ? value.dropped : undefined,
  };
}

function toEventPayload(value: unknown): ObsEventPayload | null {
  if (!isObject(value) || value.schemaVersion !== OBS_SCHEMA_VERSION) {
    return null;
  }
  const event = toEventRecord(value.event);
  if (!event) {
    return null;
  }
  return {
    schemaVersion: OBS_SCHEMA_VERSION,
    event,
  };
}

function toHealth(value: unknown): ObsHealthPayload | null {
  if (!isObject(value) || value.schemaVersion !== OBS_SCHEMA_VERSION) {
    return null;
  }
  if (!Array.isArray(value.models) || !Array.isArray(value.fallbacks)) {
    return null;
  }
  return value as unknown as ObsHealthPayload;
}

function toSpend(value: unknown): ObsSpendPayload | null {
  if (!isObject(value) || value.schemaVersion !== OBS_SCHEMA_VERSION) {
    return null;
  }
  if (!isObject(value.totals) || !Array.isArray(value.byModel) || !Array.isArray(value.byAgent)) {
    return null;
  }
  return value as unknown as ObsSpendPayload;
}

function toError(value: unknown): ObsErrorPayload | null {
  if (!isObject(value) || value.schemaVersion !== OBS_SCHEMA_VERSION) {
    return null;
  }
  if (typeof value.code !== "string" || typeof value.message !== "string") {
    return null;
  }
  return value as unknown as ObsErrorPayload;
}

export class ObservabilityStreamService {
  private readonly store: ObservabilityStore;
  private readonly onUpdate: () => void;
  private client: GatewayBrowserClient | null = null;
  private available = false;
  private subscribed = false;
  private lastError: string | null = null;
  private filters: ObsFilterInput = {};
  private lastSeenTs = 0;
  private subscribeInFlight = false;

  constructor(options: ObservabilityStreamServiceOptions) {
    this.store = new ObservabilityStore(options.maxEvents ?? 10_000);
    this.onUpdate = options.onUpdate;
  }

  getStore(): ObservabilityStore {
    return this.store;
  }

  getStatus(): ObservabilityStreamStatus {
    return {
      available: this.available,
      subscribed: this.subscribed,
      lastError: this.lastError,
      lastSeenTs: this.lastSeenTs,
    };
  }

  attachClient(client: GatewayBrowserClient | null) {
    this.client = client;
    if (!client) {
      this.available = false;
      this.subscribed = false;
      this.onUpdate();
    }
  }

  async handleHello(hello: GatewayHelloOk | null) {
    const events = Array.isArray(hello?.features?.events) ? hello?.features?.events : [];
    const methods = Array.isArray(hello?.features?.methods) ? hello?.features?.methods : [];
    this.available = events.includes(OBS_EVENT_EVENT) && methods.includes(OBS_METHOD_SUBSCRIBE);
    this.lastError = null;
    if (!this.available) {
      this.subscribed = false;
      this.onUpdate();
      return;
    }
    await this.subscribe();
  }

  handleDisconnected() {
    this.subscribed = false;
    this.onUpdate();
  }

  setFilters(filters: ObsFilterInput) {
    this.filters = { ...filters };
    if (this.subscribed) {
      void this.subscribe();
    }
  }

  async subscribe() {
    if (!this.client || !this.available || this.subscribeInFlight) {
      return;
    }
    this.subscribeInFlight = true;
    try {
      const overlapSince = this.lastSeenTs > 0 ? Math.max(0, this.lastSeenTs - 5_000) : undefined;
      const payload = {
        schemaVersion: OBS_SCHEMA_VERSION,
        filters: {
          ...this.filters,
          sinceTs: typeof this.filters.sinceTs === "number" ? this.filters.sinceTs : overlapSince,
        },
      };
      await this.client.request(OBS_METHOD_SUBSCRIBE, payload);
      this.subscribed = true;
      this.lastError = null;
      this.onUpdate();
    } catch (error) {
      this.subscribed = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onUpdate();
    } finally {
      this.subscribeInFlight = false;
    }
  }

  async unsubscribe() {
    if (!this.client || !this.subscribed) {
      return;
    }
    try {
      await this.client.request(OBS_METHOD_UNSUBSCRIBE, { schemaVersion: OBS_SCHEMA_VERSION });
      this.subscribed = false;
      this.lastError = null;
      this.onUpdate();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onUpdate();
    }
  }

  handleGatewayEvent(evt: GatewayEventFrame): boolean {
    if (evt.event === OBS_EVENT_SNAPSHOT) {
      const snapshot = toSnapshot(evt.payload);
      if (!snapshot) {
        return false;
      }
      this.store.addEvents(snapshot.events);
      for (const event of snapshot.events) {
        this.lastSeenTs = Math.max(this.lastSeenTs, event.timestamp);
      }
      this.onUpdate();
      return true;
    }

    if (evt.event === OBS_EVENT_EVENT) {
      const payload = toEventPayload(evt.payload);
      if (!payload) {
        return false;
      }
      this.store.addEvent(payload.event);
      this.lastSeenTs = Math.max(this.lastSeenTs, payload.event.timestamp);
      this.onUpdate();
      return true;
    }

    if (evt.event === OBS_EVENT_HEALTH) {
      const payload = toHealth(evt.payload);
      if (!payload) {
        return false;
      }
      this.store.setHealth(payload);
      this.onUpdate();
      return true;
    }

    if (evt.event === OBS_EVENT_SPEND) {
      const payload = toSpend(evt.payload);
      if (!payload) {
        return false;
      }
      this.store.setSpend(payload);
      this.onUpdate();
      return true;
    }

    if (evt.event === OBS_EVENT_ERROR) {
      const payload = toError(evt.payload);
      this.lastError = payload?.message ?? "observability stream error";
      this.onUpdate();
      return true;
    }

    if (evt.event === OBS_EVENT_PONG) {
      return true;
    }

    return false;
  }
}
