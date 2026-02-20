import { newUuid } from "../util/uuid.js";

export type TraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  requestId?: string;
  agentId?: string;
  attributes?: Record<string, string | number | boolean>;
};

export function createTraceId(): string {
  return newUuid();
}

export function createSpanId(): string {
  return newUuid().replace(/-/g, "").slice(0, 16);
}

export function createRootTrace(params?: {
  requestId?: string;
  agentId?: string;
  attributes?: Record<string, string | number | boolean>;
}): TraceContext {
  return {
    traceId: createTraceId(),
    spanId: createSpanId(),
    requestId: params?.requestId,
    agentId: params?.agentId,
    attributes: params?.attributes,
  };
}

export function createChildSpan(
  parent: TraceContext,
  attrs?: { attributes?: Record<string, string | number | boolean> },
): TraceContext {
  return {
    traceId: parent.traceId,
    parentSpanId: parent.spanId,
    spanId: createSpanId(),
    requestId: parent.requestId,
    agentId: parent.agentId,
    attributes: {
      ...parent.attributes,
      ...attrs?.attributes,
    },
  };
}
