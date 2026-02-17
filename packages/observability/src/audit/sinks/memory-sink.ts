import type { AuditSink, SerializedAuditEvent } from "../audit-types.js";

export class MemoryAuditSink implements AuditSink {
  private readonly events: SerializedAuditEvent[] = [];

  write(event: SerializedAuditEvent): void {
    this.events.push(event);
  }

  flush(): void {
    // no-op
  }

  close(): void {
    // no-op
  }

  getEvents(): SerializedAuditEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
  }
}
