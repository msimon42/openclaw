import type { AuditSink, SerializedAuditEvent } from "../audit-types.js";

export class CompositeAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}

  async write(event: SerializedAuditEvent): Promise<void> {
    for (const sink of this.sinks) {
      await sink.write(event);
    }
  }

  async flush(): Promise<void> {
    for (const sink of this.sinks) {
      await sink.flush?.();
    }
  }

  async close(): Promise<void> {
    for (const sink of this.sinks) {
      await sink.close?.();
    }
  }
}
