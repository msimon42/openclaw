import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { callGateway } from "../../gateway/call.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam } from "./common.js";

const ArtifactRefSchema = Type.Object(
  {
    artifactId: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CallAgentToolSchema = Type.Object(
  {
    toAgentId: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    traceId: Type.Optional(Type.String({ minLength: 1 })),
    sessionKey: Type.Optional(Type.String({ minLength: 1 })),
    artifactRefs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 64 })),
    limits: Type.Optional(
      Type.Object(
        {
          timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 600_000 })),
          maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
          maxCallsPerTrace: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          dedupeWindowMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 600_000 })),
          pairRateLimitPerMinute: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
    ),
    expectedSchema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

function defaultTraceId(fromAgentId: string, toAgentId: string): string {
  const stamp = Date.now().toString(36);
  return `trace_${fromAgentId}_to_${toAgentId}_${stamp}`;
}

export function createCallAgentTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  runId?: string;
}): AnyAgentTool {
  return {
    label: "Delegation",
    name: "call_agent",
    description:
      "Run a bounded synchronous delegation to another agent and return only summary + artifact refs.",
    parameters: CallAgentToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const fromAgentId =
        opts?.requesterAgentIdOverride ??
        resolveSessionAgentId({
          sessionKey: opts?.agentSessionKey,
        }) ??
        "main";
      const toAgentId = readStringParam(params, "toAgentId", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const traceIdRaw = readStringParam(params, "traceId");
      const traceId = traceIdRaw?.trim() || defaultTraceId(fromAgentId, toAgentId);
      const sessionKey = readStringParam(params, "sessionKey");
      const artifactRefs = Array.isArray(params.artifactRefs) ? params.artifactRefs : undefined;
      const limits =
        params.limits && typeof params.limits === "object"
          ? (params.limits as Record<string, unknown>)
          : undefined;
      const expectedSchema = params.expectedSchema;

      const result = await callGateway({
        method: "agents.call",
        params: {
          fromAgentId,
          toAgentId,
          traceId,
          sessionKey,
          message,
          artifactRefs,
          limits,
          expectedSchema,
          sourceRunId: opts?.runId,
        },
        timeoutMs: 180_000,
      });
      return jsonResult(result);
    },
  };
}

