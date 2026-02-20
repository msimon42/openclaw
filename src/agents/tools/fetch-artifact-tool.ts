import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { callGateway } from "../../gateway/call.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam } from "./common.js";

const FetchArtifactToolSchema = Type.Object(
  {
    artifactId: Type.String({ minLength: 1 }),
    traceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

function defaultTraceId(agentId: string): string {
  const stamp = Date.now().toString(36);
  return `trace_${agentId}_fetch_${stamp}`;
}

export function createFetchArtifactTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  runId?: string;
}): AnyAgentTool {
  return {
    label: "Artifacts",
    name: "fetch_artifact",
    description: "Fetch artifact content and metadata by artifactId.",
    parameters: FetchArtifactToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const fetchedByAgentId =
        opts?.requesterAgentIdOverride ??
        resolveSessionAgentId({
          sessionKey: opts?.agentSessionKey,
        }) ??
        "main";
      const artifactId = readStringParam(params, "artifactId", { required: true });
      const traceIdRaw = readStringParam(params, "traceId");
      const traceId = traceIdRaw?.trim() || defaultTraceId(fetchedByAgentId);

      const result = await callGateway({
        method: "artifacts.fetch",
        params: {
          traceId,
          fetchedByAgentId,
          artifactId,
          requestId: opts?.runId,
        },
        timeoutMs: 30_000,
      });
      return jsonResult(result);
    },
  };
}

