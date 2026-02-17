import type { AuditEvent, AuditEventInput, AuditSink } from "./audit-types.js";
import { nowMs } from "../util/now.js";
import { redactAuditEvent, type RedactionOptions } from "./audit-redaction.js";

type QueueItem = {
  event: AuditEvent;
  resolve: (event: AuditEvent) => void;
  reject: (error: unknown) => void;
};

export type AuditLoggerOptions = {
  enabled?: boolean;
  sink: AuditSink;
  redaction?: RedactionOptions;
  maxQueueSize?: number;
  defaultAgentId?: string;
};

export class AuditLogger {
  private readonly enabled: boolean;
  private readonly sink: AuditSink;
  private readonly redaction?: RedactionOptions;
  private readonly maxQueueSize: number;
  private readonly defaultAgentId: string;
  private readonly queue: QueueItem[] = [];
  private readonly flushWaiters: Array<() => void> = [];
  private draining = false;

  constructor(options: AuditLoggerOptions) {
    this.enabled = options.enabled ?? true;
    this.sink = options.sink;
    this.redaction = options.redaction;
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? 10_000);
    this.defaultAgentId = options.defaultAgentId?.trim() || "unknown";
  }

  private toEvent(input: AuditEventInput): AuditEvent {
    return {
      schemaVersion: input.schemaVersion ?? "1.0",
      eventVersion: input.eventVersion ?? "1.0",
      timestamp: input.timestamp ?? nowMs(),
      traceId: input.traceId,
      spanId: input.spanId,
      agentId: input.agentId?.trim() || this.defaultAgentId,
      skillId: input.skillId,
      pluginId: input.pluginId,
      eventType: input.eventType,
      riskTier: input.riskTier,
      decision: input.decision,
      model: input.model,
      tool: input.tool,
      metrics: input.metrics,
      payload: input.payload ?? {},
    };
  }

  private scheduleDrain() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }

  private resolveFlushWaiters() {
    const waiters = this.flushWaiters.splice(0, this.flushWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async drain() {
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) {
          continue;
        }
        try {
          const redacted = redactAuditEvent(item.event, this.redaction);
          await this.sink.write(redacted);
          item.resolve(redacted);
        } catch (error) {
          item.reject(error);
        }
      }
      await this.sink.flush?.();
    } catch {
      // Keep the queue processor alive; per-item failures are surfaced via reject().
    } finally {
      this.draining = false;
    }

    if (this.queue.length > 0) {
      this.scheduleDrain();
      return;
    }
    this.resolveFlushWaiters();
  }

  emit(input: AuditEventInput): void {
    void this.emitAsync(input);
  }

  emitAsync(input: AuditEventInput): Promise<AuditEvent> {
    const event = this.toEvent(input);
    if (!this.enabled) {
      return Promise.resolve(event);
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
    }

    const promise = new Promise<AuditEvent>((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
    });
    this.scheduleDrain();
    return promise;
  }

  async flush(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (!this.draining && this.queue.length === 0) {
      await this.sink.flush?.();
      return;
    }
    await new Promise<void>((resolve) => {
      this.flushWaiters.push(resolve);
      this.scheduleDrain();
    });
  }

  async close(): Promise<void> {
    await this.flush();
    await this.sink.close?.();
  }
}
