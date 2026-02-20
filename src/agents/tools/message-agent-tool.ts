import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { callGateway } from "../../gateway/call.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { jsonResult, readStringParam } from "./common.js";

const ArtifactRefSchema = Type.Object(
  {
    artifactId: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const MessageAgentToolSchema = Type.Object(
  {
    toAgentId: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    traceId: Type.Optional(Type.String({ minLength: 1 })),
    sessionKey: Type.Optional(Type.String({ minLength: 1 })),
    artifactRefs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 64 })),
    priority: optionalStringEnum(["low", "normal", "high", "urgent"] as const),
  },
  { additionalProperties: false },
);

function defaultTraceId(fromAgentId: string, toAgentId: string): string {
  const stamp = Date.now().toString(36);
  return `trace_${fromAgentId}_msg_${toAgentId}_${stamp}`;
}

export function createMessageAgentTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  runId?: string;
}): AnyAgentTool {
  return {
    label: "Delegation",
    name: "message_agent",
    description:
      "Inject an asynchronous inbox handoff to another agent without running it immediately.",
    parameters: MessageAgentToolSchema,
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
      const priority =
        typeof params.priority === "string" && params.priority.trim()
          ? params.priority.trim().toLowerCase()
          : undefined;

      const result = await callGateway({
        method: "agents.message",
        params: {
          fromAgentId,
          toAgentId,
          traceId,
          sessionKey,
          message,
          artifactRefs,
          priority,
          sourceRunId: opts?.runId,
        },
        timeoutMs: 30_000,
      });
      return jsonResult(result);
    },
  };
}
