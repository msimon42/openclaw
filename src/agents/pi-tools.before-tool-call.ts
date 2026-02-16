import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { evaluateSkillToolCallAccess } from "./skills/security.js";
import { loadWorkspaceSkillEntries } from "./skills/workspace.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;

function resolveSkillName(params: unknown): string | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  const skillName = params.skillName;
  if (typeof skillName !== "string") {
    return undefined;
  }
  const trimmed = skillName.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSkillSecurityDecision(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): HookOutcome | undefined {
  const skillName = resolveSkillName(args.params);
  if (!skillName) {
    return undefined;
  }
  if (!args.ctx?.workspaceDir?.trim()) {
    return {
      blocked: true,
      reason: `Skill runtime guard blocked tool call: workspace context missing for skill "${skillName}"`,
    };
  }
  if (!args.ctx.config) {
    return {
      blocked: true,
      reason: `Skill runtime guard blocked tool call: config context missing for skill "${skillName}"`,
    };
  }
  const skillEntries = loadWorkspaceSkillEntries(args.ctx.workspaceDir, {
    config: args.ctx.config,
    agentId: args.ctx.agentId,
  });
  const entry = skillEntries.find(
    (candidate) => candidate.skill.name.trim().toLowerCase() === skillName.toLowerCase(),
  );
  if (!entry) {
    return {
      blocked: true,
      reason: `Skill runtime guard blocked tool call: skill "${skillName}" is not loadable`,
    };
  }
  const policy = entry.security?.effectivePolicy;
  if (!policy) {
    return {
      blocked: true,
      reason: `Skill runtime guard blocked tool call: no effective policy for "${skillName}"`,
    };
  }
  const decision = evaluateSkillToolCallAccess({
    toolName: args.toolName,
    toolParams: isPlainObject(args.params) ? args.params : {},
    declaredCapabilities: entry.manifest?.capabilities ?? [],
    policy,
  });
  if (decision.allowed) {
    return undefined;
  }
  return {
    blocked: true,
    reason: `Skill runtime guard blocked tool call: ${decision.reason ?? "denied by policy"}`,
  };
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;
  const securityDecision = resolveSkillSecurityDecision({
    toolName,
    params,
    ctx: args.ctx,
  });
  if (securityDecision?.blocked) {
    return securityDecision;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        adjustedParamsByToolCallId.set(toolCallId, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      return await execute(toolCallId, outcome.params, signal, onUpdate);
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: false,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string): unknown {
  const params = adjustedParamsByToolCallId.get(toolCallId);
  adjustedParamsByToolCallId.delete(toolCallId);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
