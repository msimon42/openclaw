import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { callGateway } from "../../gateway/call.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam } from "./common.js";

const PublishArtifactToolSchema = Type.Object(
  {
    content: Type.Unknown(),
    kind: Type.Optional(Type.String({ minLength: 1 })),
    traceId: Type.Optional(Type.String({ minLength: 1 })),
    ttlDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
  },
  { additionalProperties: false },
);

function defaultTraceId(agentId: string): string {
  const stamp = Date.now().toString(36);
  return `trace_${agentId}_artifact_${stamp}`;
}

export function createPublishArtifactTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  runId?: string;
}): AnyAgentTool {
  return {
    label: "Artifacts",
    name: "publish_artifact",
    description: "Publish content to the shared content-addressed artifact store.",
    parameters: PublishArtifactToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const createdByAgentId =
        opts?.requesterAgentIdOverride ??
        resolveSessionAgentId({
          sessionKey: opts?.agentSessionKey,
        }) ??
        "main";
      const kind = readStringParam(params, "kind");
      const traceIdRaw = readStringParam(params, "traceId");
      const traceId = traceIdRaw?.trim() || defaultTraceId(createdByAgentId);
      const ttlDays =
        typeof params.ttlDays === "number" && Number.isFinite(params.ttlDays)
          ? Math.max(1, Math.floor(params.ttlDays))
          : undefined;
      const content = Object.prototype.hasOwnProperty.call(params, "content")
        ? params.content
        : "";

      const result = await callGateway({
        method: "artifacts.publish",
        params: {
          traceId,
          createdByAgentId,
          kind,
          content,
          ttlDays,
          requestId: opts?.runId,
        },
        timeoutMs: 30_000,
      });
      return jsonResult(result);
    },
  };
}

