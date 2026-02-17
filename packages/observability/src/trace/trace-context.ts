import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceContext } from "./trace.js";

const storage = new AsyncLocalStorage<TraceContext>();

export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

export function withChildSpan<T>(span: TraceContext, fn: () => T): T {
  return storage.run(span, fn);
}

export function setTraceAttribute(
  key: string,
  value: string | number | boolean,
): TraceContext | undefined {
  const current = storage.getStore();
  if (!current) {
    return undefined;
  }
  current.attributes = {
    ...current.attributes,
    [key]: value,
  };
  return current;
}
