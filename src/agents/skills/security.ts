import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry } from "./types.js";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { normalizeToolName } from "../tool-policy.js";
import { resolveSkillConfig } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";

export const SKILL_MANIFEST_FILENAME = "skill.manifest.json";

export const SKILL_CAPABILITIES = [
  "shell.exec",
  "network.fetch",
  "filesystem.read",
  "filesystem.write",
  "tool.invoke",
  "model.invoke",
  "plugin.load",
] as const;

const SKILL_CAPABILITY_SET = new Set<string>(SKILL_CAPABILITIES);

export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];

export type SkillPolicyConfig = {
  allow?: SkillCapability[];
  deny?: SkillCapability[];
  allowDomains?: string[];
  writePaths?: string[];
  requireApproval?: boolean;
};

export type ResolvedSkillPolicy = {
  allow: Set<SkillCapability>;
  deny: Set<SkillCapability>;
  allowDomains: string[];
  writePaths: string[];
  requireApproval: boolean;
};

export type SkillManifest = {
  id: string;
  name: string;
  version: string;
  entry: string;
  capabilities: SkillCapability[];
  permissions?: {
    allowDomains?: string[];
    writePaths?: string[];
  };
  policy?: SkillPolicyConfig;
};

export type SkillManifestLoadResult =
  | { ok: true; manifest: SkillManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

export type SkillRuntimeRequest =
  | { capability: "shell.exec" }
  | { capability: "network.fetch"; domains: string[] }
  | { capability: "filesystem.write"; paths: string[] };

export type SkillRuntimeDecision = {
  allowed: boolean;
  reason?: string;
};

export const SKILL_MANIFEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "version", "entry", "capabilities"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    entry: { type: "string", minLength: 1 },
    capabilities: {
      type: "array",
      minItems: 1,
      items: {
        type: "string",
        enum: SKILL_CAPABILITIES,
      },
    },
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowDomains: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        writePaths: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        allow: {
          type: "array",
          items: { type: "string", enum: SKILL_CAPABILITIES },
        },
        deny: {
          type: "array",
          items: { type: "string", enum: SKILL_CAPABILITIES },
        },
        allowDomains: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        writePaths: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        requireApproval: { type: "boolean" },
      },
    },
  },
} as const;

const SKILL_MANIFEST_CACHE_KEY = "skills:manifest:v1";

const UNTRUSTED_SKILL_SOURCES = new Set<string>([
  "openclaw-managed",
  "openclaw-extra",
  "agents-skills-personal",
  "agents-skills-project",
]);

const HARDCODED_SKILL_POLICY: SkillPolicyConfig = {
  deny: ["plugin.load"],
};

const URL_RE = /\bhttps?:\/\/[^\s"'`<>]+/gi;

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
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

function normalizeSkillPolicy(input: unknown): SkillPolicyConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const allow = normalizeCapabilityList(raw.allow);
  const deny = normalizeCapabilityList(raw.deny);
  const allowDomains = normalizeStringList(raw.allowDomains);
  const writePaths = normalizeStringList(raw.writePaths);
  const requireApproval =
    typeof raw.requireApproval === "boolean" ? raw.requireApproval : undefined;
  if (
    allow.length === 0 &&
    deny.length === 0 &&
    allowDomains.length === 0 &&
    writePaths.length === 0 &&
    requireApproval === undefined
  ) {
    return undefined;
  }
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
    ...(allowDomains.length > 0 ? { allowDomains } : {}),
    ...(writePaths.length > 0 ? { writePaths } : {}),
    ...(requireApproval !== undefined ? { requireApproval } : {}),
  };
}

function mergeSkillPolicy(
  base: SkillPolicyConfig | undefined,
  override: SkillPolicyConfig | undefined,
): SkillPolicyConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

export function isManifestRequiredForSource(source: string): boolean {
  return UNTRUSTED_SKILL_SOURCES.has(source.trim().toLowerCase());
}

export function loadSkillManifest(skillBaseDir: string): SkillManifestLoadResult {
  const manifestPath = path.join(skillBaseDir, SKILL_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: "skill manifest missing", manifestPath };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON in skill manifest: ${String(err)}`,
      manifestPath,
    };
  }
  const validation = validateJsonSchemaValue({
    schema: SKILL_MANIFEST_SCHEMA as unknown as Record<string, unknown>,
    cacheKey: SKILL_MANIFEST_CACHE_KEY,
    value: raw,
  });
  if (!validation.ok) {
    return {
      ok: false,
      error: `skill manifest schema validation failed: ${validation.errors.join("; ")}`,
      manifestPath,
    };
  }

  const record = raw as Record<string, unknown>;
  const capabilities = normalizeCapabilityList(record.capabilities);
  if (capabilities.length === 0) {
    return { ok: false, error: "skill manifest has no valid capabilities", manifestPath };
  }
  const rawCaps = Array.isArray(record.capabilities) ? record.capabilities.length : 0;
  if (capabilities.length !== rawCaps) {
    return {
      ok: false,
      error: "skill manifest contains unsupported capabilities",
      manifestPath,
    };
  }

  const permissionsRaw =
    record.permissions &&
    typeof record.permissions === "object" &&
    !Array.isArray(record.permissions)
      ? (record.permissions as Record<string, unknown>)
      : undefined;
  const permissions = permissionsRaw
    ? {
        ...(normalizeStringList(permissionsRaw.allowDomains).length > 0
          ? { allowDomains: normalizeStringList(permissionsRaw.allowDomains) }
          : {}),
        ...(normalizeStringList(permissionsRaw.writePaths).length > 0
          ? { writePaths: normalizeStringList(permissionsRaw.writePaths) }
          : {}),
      }
    : undefined;

  const policy = normalizeSkillPolicy(record.policy);

  return {
    ok: true,
    manifestPath,
    manifest: {
      id: String(record.id),
      name: String(record.name),
      version: String(record.version),
      entry: String(record.entry),
      capabilities,
      ...(permissions && Object.keys(permissions).length > 0 ? { permissions } : {}),
      ...(policy ? { policy } : {}),
    },
  };
}

function normalizeWritePaths(input: string[]): string[] {
  return Array.from(
    new Set(
      input
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => path.resolve(entry)),
    ),
  );
}

export function resolveSkillPolicy(params: {
  hardcodedPolicy?: SkillPolicyConfig;
  globalPolicy?: SkillPolicyConfig;
  agentPolicy?: SkillPolicyConfig;
  skillPolicy?: SkillPolicyConfig;
}): ResolvedSkillPolicy {
  const layers: Array<SkillPolicyConfig | undefined> = [
    params.hardcodedPolicy ?? HARDCODED_SKILL_POLICY,
    params.globalPolicy,
    params.agentPolicy,
    params.skillPolicy,
  ];
  const state: ResolvedSkillPolicy = {
    allow: new Set<SkillCapability>(),
    deny: new Set<SkillCapability>(),
    allowDomains: [],
    writePaths: [],
    requireApproval: false,
  };

  for (const layer of layers) {
    if (!layer) {
      continue;
    }
    if (layer.allow !== undefined) {
      state.allow = new Set(normalizeCapabilityList(layer.allow));
    }
    if (layer.deny !== undefined) {
      state.deny = new Set(normalizeCapabilityList(layer.deny));
    }
    if (layer.allowDomains !== undefined) {
      state.allowDomains = Array.from(
        new Set(normalizeStringList(layer.allowDomains).map((entry) => entry.trim().toLowerCase())),
      );
    }
    if (layer.writePaths !== undefined) {
      state.writePaths = normalizeWritePaths(normalizeStringList(layer.writePaths));
    }
    if (layer.requireApproval !== undefined) {
      state.requireApproval = layer.requireApproval;
    }
  }
  return state;
}

function resolveSkillPolicyFromManifest(manifest?: SkillManifest): SkillPolicyConfig | undefined {
  if (!manifest) {
    return undefined;
  }
  const fromPermissions: SkillPolicyConfig = {
    ...(manifest.permissions?.allowDomains
      ? { allowDomains: manifest.permissions.allowDomains }
      : {}),
    ...(manifest.permissions?.writePaths ? { writePaths: manifest.permissions.writePaths } : {}),
  };
  const permissionsPolicy =
    Object.keys(fromPermissions).length > 0 ? normalizeSkillPolicy(fromPermissions) : undefined;
  return mergeSkillPolicy(permissionsPolicy, manifest.policy);
}

export function resolveSkillPolicyForEntry(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  agentId?: string;
}): ResolvedSkillPolicy {
  const skillKey = resolveSkillKey(params.entry.skill, params.entry);
  const skillConfig = resolveSkillConfig(params.config, skillKey);
  const globalPolicy = normalizeSkillPolicy(params.config?.skills?.policy);
  const agentPolicy =
    params.config && params.agentId
      ? normalizeSkillPolicy(resolveAgentConfig(params.config, params.agentId)?.skillsPolicy)
      : undefined;
  const manifestSkillPolicy = resolveSkillPolicyFromManifest(params.entry.manifest);
  const skillOverridePolicy = normalizeSkillPolicy(skillConfig?.policy);
  const skillPolicy = mergeSkillPolicy(manifestSkillPolicy, skillOverridePolicy);
  return resolveSkillPolicy({
    globalPolicy,
    agentPolicy,
    skillPolicy,
  });
}

export function isSkillCapabilityAllowed(
  policy: ResolvedSkillPolicy,
  capability: SkillCapability,
): boolean {
  if (policy.deny.has(capability)) {
    return false;
  }
  if (policy.allow.size === 0) {
    return true;
  }
  return policy.allow.has(capability);
}

export function validateSkillCapabilities(params: {
  policy: ResolvedSkillPolicy;
  capabilities: SkillCapability[];
}): { ok: true } | { ok: false; blocked: SkillCapability[] } {
  const blocked = params.capabilities.filter(
    (capability) => !isSkillCapabilityAllowed(params.policy, capability),
  );
  if (blocked.length === 0) {
    return { ok: true };
  }
  return { ok: false, blocked };
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const base = path.resolve(basePath);
  const candidate = path.resolve(candidatePath);
  const rel = path.relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function isDomainAllowed(domain: string, allowDomains: string[]): boolean {
  const normalized = normalizeDomain(domain);
  for (const rawRule of allowDomains) {
    const rule = normalizeDomain(rawRule);
    if (!rule) {
      continue;
    }
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1);
      if (normalized.endsWith(suffix)) {
        return true;
      }
      continue;
    }
    if (rule.startsWith(".")) {
      if (normalized.endsWith(rule)) {
        return true;
      }
      continue;
    }
    if (normalized === rule) {
      return true;
    }
  }
  return false;
}

function extractDomainsFromString(input: string): string[] {
  const out = new Set<string>();
  const matches = input.match(URL_RE) ?? [];
  for (const match of matches) {
    try {
      const host = new URL(match).hostname.trim().toLowerCase();
      if (host) {
        out.add(host);
      }
    } catch {
      // ignore invalid URLs
    }
  }
  return Array.from(out);
}

function extractDomainsFromParams(params: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const maybeUrlValues = [
    params.url,
    params.href,
    params.uri,
    params.command,
    params.input,
    params.text,
    params.query,
  ];
  for (const value of maybeUrlValues) {
    if (typeof value !== "string") {
      continue;
    }
    for (const domain of extractDomainsFromString(value)) {
      out.add(domain);
    }
  }
  const urls = params.urls;
  if (Array.isArray(urls)) {
    for (const value of urls) {
      if (typeof value !== "string") {
        continue;
      }
      for (const domain of extractDomainsFromString(value)) {
        out.add(domain);
      }
    }
  }
  return Array.from(out);
}

function parsePatchTargetPaths(input: string): string[] {
  const out = new Set<string>();
  const targetRe = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  const moveRe = /^\*\*\* Move to: (.+)$/gm;
  let match: RegExpExecArray | null = targetRe.exec(input);
  while (match) {
    const target = match[1]?.trim();
    if (target) {
      out.add(target);
    }
    match = targetRe.exec(input);
  }
  match = moveRe.exec(input);
  while (match) {
    const target = match[1]?.trim();
    if (target) {
      out.add(target);
    }
    match = moveRe.exec(input);
  }
  return Array.from(out);
}

function extractWritePathsFromParams(params: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const direct = [
    params.path,
    params.filePath,
    params.file_path,
    params.filename,
    params.file,
    params.target,
    params.cwd,
  ];
  for (const value of direct) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }

  if (typeof params.input === "string") {
    for (const filePath of parsePatchTargetPaths(params.input)) {
      out.add(filePath);
    }
  }
  if (typeof params.command === "string") {
    for (const filePath of parsePatchTargetPaths(params.command)) {
      out.add(filePath);
    }
  }

  return Array.from(out);
}

export function inferSkillRuntimeRequestFromToolCall(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
}): SkillRuntimeRequest | undefined {
  const name = normalizeToolName(params.toolName);
  if (name === "exec" || name === "bash") {
    return { capability: "shell.exec" };
  }
  if (name === "web_fetch" || name === "web_search") {
    return {
      capability: "network.fetch",
      domains: extractDomainsFromParams(params.toolParams),
    };
  }
  if (name === "write" || name === "edit" || name === "apply_patch") {
    return {
      capability: "filesystem.write",
      paths: extractWritePathsFromParams(params.toolParams),
    };
  }
  return undefined;
}

export function evaluateSkillRuntimeAccess(params: {
  policy: ResolvedSkillPolicy;
  request: SkillRuntimeRequest;
}): SkillRuntimeDecision {
  if (!isSkillCapabilityAllowed(params.policy, params.request.capability)) {
    return {
      allowed: false,
      reason: `capability denied by policy: ${params.request.capability}`,
    };
  }

  if (params.request.capability === "network.fetch") {
    if (params.policy.allowDomains.length === 0) {
      return {
        allowed: false,
        reason: "network.fetch denied: allowDomains is empty",
      };
    }
    if (params.request.domains.length === 0) {
      return {
        allowed: false,
        reason: "network.fetch denied: no domain could be resolved from request",
      };
    }
    const blocked = params.request.domains.filter(
      (domain) => !isDomainAllowed(domain, params.policy.allowDomains),
    );
    if (blocked.length > 0) {
      return {
        allowed: false,
        reason: `network.fetch denied for domain(s): ${blocked.join(", ")}`,
      };
    }
  }

  if (params.request.capability === "filesystem.write") {
    if (params.policy.writePaths.length === 0) {
      return {
        allowed: false,
        reason: "filesystem.write denied: writePaths is empty",
      };
    }
    if (params.request.paths.length === 0) {
      return {
        allowed: false,
        reason: "filesystem.write denied: no target path could be resolved from request",
      };
    }
    for (const target of params.request.paths) {
      const resolvedTarget = path.resolve(target);
      const allowed = params.policy.writePaths.some((basePath) =>
        isPathInside(basePath, resolvedTarget),
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `filesystem.write denied for path: ${resolvedTarget}`,
        };
      }
    }
  }

  return { allowed: true };
}

export function evaluateSkillToolCallAccess(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
  declaredCapabilities: SkillCapability[];
  policy: ResolvedSkillPolicy;
}): SkillRuntimeDecision {
  const request = inferSkillRuntimeRequestFromToolCall({
    toolName: params.toolName,
    toolParams: params.toolParams,
  });
  if (!request) {
    return { allowed: true };
  }
  if (!params.declaredCapabilities.includes(request.capability)) {
    return {
      allowed: false,
      reason: `skill capability not declared in manifest: ${request.capability}`,
    };
  }
  return evaluateSkillRuntimeAccess({ policy: params.policy, request });
}
