import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { describeBinding } from "./agents.bindings.js";
import { requireValidConfig } from "./agents.command-shared.js";

export type BindingsExplainOptions = {
  channel: string;
  account?: string;
  peer?: string;
  peerKind?: string;
  json?: boolean;
};

function normalizePeerKind(value: string | undefined): ChatType {
  const normalized = normalizeChatType(value);
  return normalized ?? "direct";
}

function resolveMatchedRuleDescription(params: {
  ruleId?: string;
  cfg: NonNullable<Awaited<ReturnType<typeof requireValidConfig>>>;
}): string | undefined {
  if (!params.ruleId) {
    return undefined;
  }
  const match = /^binding:(\d+)$/.exec(params.ruleId.trim());
  if (!match) {
    return undefined;
  }
  const index = Number.parseInt(match[1] ?? "", 10) - 1;
  if (!Number.isInteger(index) || index < 0) {
    return undefined;
  }
  const binding = params.cfg.bindings?.[index];
  if (!binding) {
    return undefined;
  }
  return describeBinding(binding);
}

export async function bindingsExplainCommand(
  opts: BindingsExplainOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  const channel = opts.channel?.trim().toLowerCase();
  if (!channel) {
    runtime.error("Channel is required.");
    runtime.exit(1);
    return;
  }
  const accountId = opts.account?.trim() || DEFAULT_ACCOUNT_ID;
  const peerId = opts.peer?.trim();
  const peerKind = normalizePeerKind(opts.peerKind);

  const route = resolveAgentRoute({
    cfg,
    channel,
    accountId,
    peer: peerId ? { kind: peerKind, id: peerId } : undefined,
  });
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const matchedRule = resolveMatchedRuleDescription({ ruleId: route.matchedRuleId, cfg });
  const result = {
    selectedAgentId: route.agentId,
    matchedBy: route.matchedBy,
    ruleId: route.matchedRuleId ?? null,
    rule: matchedRule ?? null,
    specificity: route.specificity,
    accountId,
    channel,
    peer: peerId ? { kind: peerKind, id: peerId } : null,
    fallback: {
      defaultAgentId,
      path:
        route.matchedBy === "default"
          ? "no binding matched; default agent selected"
          : "binding matched; fallback default not used",
    },
  };

  if (opts.json) {
    runtime.log(JSON.stringify(result, null, 2));
    return;
  }

  runtime.log(`Selected agent: ${result.selectedAgentId}`);
  runtime.log(`Matched by: ${result.matchedBy}`);
  runtime.log(`Rule: ${result.ruleId ?? "default"}${matchedRule ? ` (${matchedRule})` : ""}`);
  runtime.log(`Specificity: ${result.specificity}`);
  runtime.log(`Fallback default agent: ${result.fallback.defaultAgentId}`);
  runtime.log(`Fallback path: ${result.fallback.path}`);
}

