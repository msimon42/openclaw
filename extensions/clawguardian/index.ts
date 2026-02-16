import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";
import {
  evaluateSkillRuntimeAccess,
  inferSkillRuntimeRequestFromToolCall,
  resolveSkillPolicy,
  SKILL_CAPABILITIES,
  type SkillCapability,
  type SkillPolicyConfig,
} from "../../src/agents/skills/security.js";

type RiskTier = "low" | "medium" | "high" | "critical";
type Scope = "session" | "agent" | "global";

type RiskTierConfig = {
  requireApproval?: boolean;
};

type RateLimitConfig = {
  enabled?: boolean;
  windowMs?: number;
  maxCalls?: number;
  scope?: Scope;
};

type ClawGuardianConfig = {
  enabled?: boolean;
  policy?: SkillPolicyConfig;
  toolPolicies?: Record<string, SkillPolicyConfig>;
  riskTiers?: Partial<Record<RiskTier, RiskTierConfig>>;
  highRiskTools?: string[];
  rateLimit?: RateLimitConfig;
};

type AuditDecision = "allow" | "deny" | "require_approval";

type ClawGuardianAuditEvent = {
  timestamp: string;
  traceId: string;
  pluginId: "clawguardian";
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  decision: AuditDecision;
  riskTier: RiskTier;
  reason?: string;
  payload: Record<string, unknown>;
};

type RateLimitState = {
  enabled: boolean;
  windowMs: number;
  maxCalls: number;
  scope: Scope;
  buckets: Map<string, number[]>;
};

const HIGH_RISK_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\b(curl|wget)\b[^|\n\r]*\|\s*(bash|sh|zsh|pwsh|powershell)\b/i,
  /\b(Invoke-Expression|iex)\b/i,
  /\bpowershell\b[^|\n\r]*\s-enc(?:odedcommand)?\b/i,
  /\bchmod\s+777\b/i,
];

const CRITICAL_COMMAND_PATTERNS = [
  /\b(curl|wget)\b[^|\n\r]*\|\s*(bash|sh|zsh|pwsh|powershell)\b/i,
  /\bmkfs\./i,
  /\bdd\s+if=/i,
];
const SKILL_CAPABILITY_SET = new Set<string>(SKILL_CAPABILITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCapabilityList(input: unknown): SkillCapability[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: SkillCapability[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim().toLowerCase();
    if (!SKILL_CAPABILITY_SET.has(normalized)) {
      continue;
    }
    out.push(normalized as SkillCapability);
  }
  return Array.from(new Set(out));
}

function normalizePolicy(input: unknown): SkillPolicyConfig | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const policy: SkillPolicyConfig = {};
  const allow = normalizeCapabilityList(input.allow);
  if (allow.length > 0) {
    policy.allow = allow;
  }
  const deny = normalizeCapabilityList(input.deny);
  if (deny.length > 0) {
    policy.deny = deny;
  }
  if (Array.isArray(input.allowDomains)) {
    policy.allowDomains = input.allowDomains.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (Array.isArray(input.writePaths)) {
    policy.writePaths = input.writePaths.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (typeof input.requireApproval === "boolean") {
    policy.requireApproval = input.requireApproval;
  }
  if (Object.keys(policy).length === 0) {
    return undefined;
  }
  return policy;
}

function normalizeRiskTiers(value: unknown): Partial<Record<RiskTier, RiskTierConfig>> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Partial<Record<RiskTier, RiskTierConfig>> = {};
  for (const tier of ["low", "medium", "high", "critical"] as const) {
    const entry = value[tier];
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.requireApproval === "boolean") {
      out[tier] = { requireApproval: entry.requireApproval };
    }
  }
  return out;
}

function normalizeToolPolicyMap(value: unknown): Record<string, SkillPolicyConfig> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, SkillPolicyConfig> = {};
  for (const [toolName, rawPolicy] of Object.entries(value)) {
    const normalizedName = normalizeToolName(toolName);
    if (!normalizedName) {
      continue;
    }
    const policy = normalizePolicy(rawPolicy);
    if (!policy) {
      continue;
    }
    out[normalizedName] = policy;
  }
  return out;
}

function normalizeRateLimit(input: unknown): RateLimitState {
  const fallback: RateLimitState = {
    enabled: false,
    windowMs: 60_000,
    maxCalls: 50,
    scope: "session",
    buckets: new Map(),
  };
  if (!isRecord(input)) {
    return fallback;
  }
  const scopeRaw = typeof input.scope === "string" ? input.scope.trim().toLowerCase() : "";
  const scope: Scope =
    scopeRaw === "agent" || scopeRaw === "global" || scopeRaw === "session" ? scopeRaw : "session";
  return {
    enabled: input.enabled === true,
    windowMs:
      typeof input.windowMs === "number" && Number.isFinite(input.windowMs) && input.windowMs > 0
        ? Math.floor(input.windowMs)
        : 60_000,
    maxCalls:
      typeof input.maxCalls === "number" && Number.isFinite(input.maxCalls) && input.maxCalls > 0
        ? Math.floor(input.maxCalls)
        : 50,
    scope,
    buckets: new Map(),
  };
}

function resolveRateLimitKey(params: {
  toolName: string;
  sessionKey?: string;
  agentId?: string;
  scope: Scope;
}): string {
  if (params.scope === "global") {
    return `global:${params.toolName}`;
  }
  if (params.scope === "agent") {
    return `agent:${params.agentId?.trim() || "unknown"}:${params.toolName}`;
  }
  return `session:${params.sessionKey?.trim() || "unknown"}:${params.toolName}`;
}

function consumeRateLimit(params: {
  state: RateLimitState;
  toolName: string;
  sessionKey?: string;
  agentId?: string;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!params.state.enabled) {
    return { allowed: true };
  }
  const now = Date.now();
  const key = resolveRateLimitKey({
    toolName: params.toolName,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    scope: params.state.scope,
  });
  const existing = params.state.buckets.get(key) ?? [];
  const fresh = existing.filter((ts) => now - ts < params.state.windowMs);
  if (fresh.length >= params.state.maxCalls) {
    params.state.buckets.set(key, fresh);
    return {
      allowed: false,
      reason: `rate limit exceeded for ${params.toolName} (${fresh.length}/${params.state.maxCalls} in ${params.state.windowMs}ms)`,
    };
  }
  fresh.push(now);
  params.state.buckets.set(key, fresh);
  return { allowed: true };
}

function extractCommandText(params: Record<string, unknown>): string {
  for (const key of ["command", "input", "query", "text"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function classifyRiskTier(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
  highRiskTools: Set<string>;
}): RiskTier {
  if (params.highRiskTools.has(params.toolName)) {
    return "high";
  }
  const commandText = extractCommandText(params.toolParams);
  if (params.toolName === "exec" || params.toolName === "bash") {
    if (CRITICAL_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText))) {
      return "critical";
    }
    if (HIGH_RISK_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText))) {
      return "high";
    }
    return "high";
  }
  if (
    params.toolName === "apply_patch" ||
    params.toolName === "edit" ||
    params.toolName === "write"
  ) {
    return "medium";
  }
  if (params.toolName === "web_fetch" || params.toolName === "web_search") {
    return "medium";
  }
  return "low";
}

function emitAuditEvent(params: {
  api: OpenClawPluginApi;
  toolName: string;
  decision: AuditDecision;
  riskTier: RiskTier;
  reason?: string;
  sessionKey?: string;
  agentId?: string;
  payload?: Record<string, unknown>;
}) {
  const event: ClawGuardianAuditEvent = {
    timestamp: new Date().toISOString(),
    traceId: randomUUID(),
    pluginId: "clawguardian",
    toolName: params.toolName,
    decision: params.decision,
    riskTier: params.riskTier,
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    payload: params.payload ?? {},
  };
  params.api.logger.info(`[clawguardian:audit] ${JSON.stringify(event)}`);
  if ((params.decision === "deny" || params.decision === "require_approval") && params.sessionKey) {
    try {
      params.api.runtime.system.enqueueSystemEvent(
        `clawguardian ${params.decision}: ${params.toolName}${params.reason ? ` (${params.reason})` : ""}`,
        {
          sessionKey: params.sessionKey,
          contextKey: `clawguardian:${params.toolName}`,
        },
      );
    } catch {
      // ignore session event failures to avoid breaking tool execution path
    }
  }
}

export default function register(api: OpenClawPluginApi) {
  const config = (isRecord(api.pluginConfig) ? api.pluginConfig : {}) as ClawGuardianConfig;
  const enabled = config.enabled !== false;
  if (!enabled) {
    api.logger.info("[clawguardian] disabled by config");
    return;
  }

  const basePolicy = normalizePolicy(config.policy);
  const toolPolicies = normalizeToolPolicyMap(config.toolPolicies);
  const riskTierConfig = normalizeRiskTiers(config.riskTiers);
  const highRiskTools = new Set(
    (Array.isArray(config.highRiskTools) ? config.highRiskTools : [])
      .map((toolName) => (typeof toolName === "string" ? normalizeToolName(toolName) : ""))
      .filter(Boolean),
  );
  const rateLimit = normalizeRateLimit(config.rateLimit);

  api.on("before_tool_call", (event, ctx) => {
    const toolName = normalizeToolName(event.toolName);
    const toolParams = isRecord(event.params) ? event.params : {};
    const riskTier = classifyRiskTier({
      toolName,
      toolParams,
      highRiskTools,
    });
    const rateLimitDecision = consumeRateLimit({
      state: rateLimit,
      toolName,
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
    });
    if (!rateLimitDecision.allowed) {
      emitAuditEvent({
        api,
        toolName,
        decision: "deny",
        riskTier,
        reason: rateLimitDecision.reason,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        payload: { stage: "rate_limit" },
      });
      return {
        block: true,
        blockReason: `ClawGuardian blocked tool call: ${rateLimitDecision.reason}`,
      };
    }

    const toolPolicy = toolPolicies[toolName];
    const resolvedPolicy = resolveSkillPolicy({
      globalPolicy: basePolicy,
      skillPolicy: toolPolicy,
    });
    const request = inferSkillRuntimeRequestFromToolCall({
      toolName,
      toolParams,
    });
    if (request) {
      const decision = evaluateSkillRuntimeAccess({
        policy: resolvedPolicy,
        request,
      });
      if (!decision.allowed) {
        const reason = decision.reason ?? "policy denied request";
        emitAuditEvent({
          api,
          toolName,
          decision: "deny",
          riskTier,
          reason,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          payload: { stage: "policy" },
        });
        return {
          block: true,
          blockReason: `ClawGuardian blocked tool call: ${reason}`,
        };
      }
    }

    const requiresApproval =
      resolvedPolicy.requireApproval === true || riskTierConfig[riskTier]?.requireApproval === true;
    if (requiresApproval) {
      const reason = `approval required for ${toolName} (risk=${riskTier})`;
      emitAuditEvent({
        api,
        toolName,
        decision: "require_approval",
        riskTier,
        reason,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        payload: { stage: "approval_gate" },
      });
      return {
        block: true,
        blockReason: `ClawGuardian blocked tool call: ${reason}`,
      };
    }

    emitAuditEvent({
      api,
      toolName,
      decision: "allow",
      riskTier,
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      payload: { stage: "allow" },
    });
    return;
  });
}
