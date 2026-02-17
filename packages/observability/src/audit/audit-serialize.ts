import type { SerializedAuditEvent } from "./audit-types.js";

type JsonReplacer = (this: unknown, key: string, value: unknown) => unknown;

const BIGINT_TAG = "[BIGINT]";
const CIRCULAR_TAG = "[CIRCULAR]";

function createSafeReplacer(): JsonReplacer {
  const seen = new WeakSet<object>();
  return function replacer(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
      return `${BIGINT_TAG}${value.toString()}`;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return CIRCULAR_TAG;
    }
    seen.add(value);
    return value;
  };
}

function truncatePayload(event: SerializedAuditEvent): SerializedAuditEvent {
  const payload = event.payload ?? {};
  const payloadString = JSON.stringify(payload, createSafeReplacer());
  return {
    ...event,
    payload: {
      truncated: true,
      originalLength: payloadString?.length ?? 0,
    },
  };
}

export function serializeAuditEvent(
  event: SerializedAuditEvent,
  options?: { maxPayloadBytes?: number },
): string {
  const maxPayloadBytes = options?.maxPayloadBytes ?? 256_000;
  const serialized = JSON.stringify(event, createSafeReplacer());
  if (serialized.length <= maxPayloadBytes) {
    return serialized;
  }
  return JSON.stringify(truncatePayload(event), createSafeReplacer());
}
