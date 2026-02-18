import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import {
  fetchArtifact,
  maybeAutoPublishLongPayload,
  publishArtifact,
  type ArtifactRef,
  writeHandoffBrief,
} from "../../agents/artifacts.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceOnboardingCompleted,
} from "../../agents/workspace.js";
import { movePathToTrash } from "../../browser/trash.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsCallParams,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
  validateAgentsListParams,
  validateAgentsMessageParams,
  validateArtifactsFetchParams,
  validateArtifactsPublishParams,
  validateAgentsUpdateParams,
} from "../protocol/index.js";
import { observeAgentCallEnd, observeAgentCallError, observeAgentCallStart, observeAgentMessage } from "../../infra/observability.js";
import { waitForAgentJob } from "./agent-job.js";
import { agentHandlers } from "./agent.js";
import { chatHandlers } from "./chat.js";
import {
  listAgentsForGateway,
  loadSessionEntry,
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";
import { updateSessionStore } from "../../config/sessions.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;
const BOOTSTRAP_FILE_NAMES_POST_ONBOARDING = BOOTSTRAP_FILE_NAMES.filter(
  (name) => name !== DEFAULT_BOOTSTRAP_FILENAME,
);

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const;

const ALLOWED_FILE_NAMES = new Set<string>([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);

function resolveAgentWorkspaceFileOrRespondError(
  params: Record<string, unknown>,
  respond: RespondFn,
): {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const cfg = loadConfig();
  const rawAgentId = params.agentId;
  const agentId = resolveAgentIdOrError(
    typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "",
    cfg,
  );
  if (!agentId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  const rawName = params.name;
  const name = (
    typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : ""
  ).trim();
  if (!ALLOWED_FILE_NAMES.has(name)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { cfg, agentId, workspaceDir, name };
}

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

async function statFile(filePath: string): Promise<FileMeta | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      size: stat.size,
      updatedAtMs: Math.floor(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

async function listAgentFiles(workspaceDir: string, options?: { hideBootstrap?: boolean }) {
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  const bootstrapFileNames = options?.hideBootstrap
    ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING
    : BOOTSTRAP_FILE_NAMES;
  for (const name of bootstrapFileNames) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statFile(filePath);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  const primaryMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
  const primaryMeta = await statFile(primaryMemoryPath);
  if (primaryMeta) {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: primaryMemoryPath,
      missing: false,
      size: primaryMeta.size,
      updatedAtMs: primaryMeta.updatedAtMs,
    });
  } else {
    const altMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_ALT_FILENAME);
    const altMeta = await statFile(altMemoryPath);
    if (altMeta) {
      files.push({
        name: DEFAULT_MEMORY_ALT_FILENAME,
        path: altMemoryPath,
        missing: false,
        size: altMeta.size,
        updatedAtMs: altMeta.updatedAtMs,
      });
    } else {
      files.push({ name: DEFAULT_MEMORY_FILENAME, path: primaryMemoryPath, missing: true });
    }
  }

  return files;
}

function resolveAgentIdOrError(agentIdRaw: string, cfg: ReturnType<typeof loadConfig>) {
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return null;
  }
  return agentId;
}

function sanitizeIdentityLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolveOptionalStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatUnknownError(value: unknown, fallback: string): string {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (value instanceof Error) {
    return value.message.trim() || fallback;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && serialized.trim() ? serialized : fallback;
  } catch {
    return fallback;
  }
}

async function moveToTrashBestEffort(pathname: string): Promise<void> {
  if (!pathname) {
    return;
  }
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await movePathToTrash(pathname);
  } catch {
    // Best-effort: path may already be gone or trash unavailable.
  }
}

type DelegationLimits = {
  timeoutMs: number;
  maxDepth: number;
  maxCallsPerTrace: number;
  maxToolCalls: number;
  dedupeWindowMs: number;
  pairRateLimitPerMinute: number;
};

type TraceGuardState = {
  activeDepth: number;
  callCount: number;
  lastTouchedAt: number;
  taskHashes: Map<string, number>;
  pairWindows: Map<string, number[]>;
};

const DEFAULT_DELEGATION_LIMITS: DelegationLimits = {
  timeoutMs: 120_000,
  maxDepth: 3,
  maxCallsPerTrace: 8,
  maxToolCalls: 24,
  dedupeWindowMs: 60_000,
  pairRateLimitPerMinute: 6,
};

const traceGuards = new Map<string, TraceGuardState>();
const TRACE_GUARD_TTL_MS = 15 * 60_000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveDelegationLimits(
  cfg: ReturnType<typeof loadConfig>,
  raw: Record<string, unknown> | undefined,
): DelegationLimits {
  const configured = cfg.agents?.defaults?.multiAgent?.delegation;
  return {
    timeoutMs: clampInt(
      raw?.timeoutMs,
      clampInt(configured?.timeoutMs, DEFAULT_DELEGATION_LIMITS.timeoutMs, 100, 600_000),
      100,
      600_000,
    ),
    maxDepth: clampInt(
      raw?.maxDepth,
      clampInt(configured?.maxDepth, DEFAULT_DELEGATION_LIMITS.maxDepth, 1, 10),
      1,
      10,
    ),
    maxCallsPerTrace: clampInt(
      raw?.maxCallsPerTrace,
      clampInt(configured?.maxCallsPerTrace, DEFAULT_DELEGATION_LIMITS.maxCallsPerTrace, 1, 100),
      1,
      100,
    ),
    maxToolCalls: clampInt(
      raw?.maxToolCalls,
      clampInt(configured?.maxToolCalls, DEFAULT_DELEGATION_LIMITS.maxToolCalls, 1, 200),
      1,
      200,
    ),
    dedupeWindowMs: clampInt(
      raw?.dedupeWindowMs,
      clampInt(configured?.dedupeWindowMs, DEFAULT_DELEGATION_LIMITS.dedupeWindowMs, 1_000, 600_000),
      1_000,
      600_000,
    ),
    pairRateLimitPerMinute: clampInt(
      raw?.pairRateLimitPerMinute,
      clampInt(
        configured?.pairRateLimitPerMinute,
        DEFAULT_DELEGATION_LIMITS.pairRateLimitPerMinute,
        1,
        100,
      ),
      1,
      100,
    ),
  };
}

function ensureKnownAgentId(agentIdRaw: unknown, cfg: ReturnType<typeof loadConfig>): string | null {
  const value = typeof agentIdRaw === "string" ? agentIdRaw : "";
  return resolveAgentIdOrError(value, cfg);
}

function sanitizeTraceId(value: string): string {
  const trimmed = value.trim();
  return trimmed || `trace_${Date.now().toString(36)}`;
}

function sanitizeWorkflowTraceToken(traceId: string): string {
  const token = traceId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return token || "workflow";
}

function normalizeArtifactRefs(raw: unknown): ArtifactRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const refs: ArtifactRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as { artifactId?: unknown; kind?: unknown; note?: unknown };
    const artifactId = typeof item.artifactId === "string" ? item.artifactId.trim() : "";
    const kind = typeof item.kind === "string" ? item.kind.trim() : "";
    if (!artifactId || !kind) {
      continue;
    }
    const note = typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined;
    refs.push({ artifactId, kind, note });
  }
  return refs;
}

function renderDelegationMessage(params: {
  fromAgentId: string;
  message: string;
  artifactRefs: ArtifactRef[];
  traceId: string;
}): string {
  const lines: string[] = [
    `[Delegation from ${params.fromAgentId}]`,
    `Trace: ${params.traceId}`,
    "",
    params.message.trim(),
  ];
  if (params.artifactRefs.length > 0) {
    lines.push("", "Artifact refs:");
    for (const ref of params.artifactRefs) {
      lines.push(`- ${ref.artifactId} (${ref.kind})${ref.note ? `: ${ref.note}` : ""}`);
    }
  }
  return lines.join("\n").trim();
}

function pruneTraceGuards(now = Date.now()): void {
  for (const [traceId, state] of traceGuards.entries()) {
    if (state.activeDepth > 0) {
      continue;
    }
    if (now - state.lastTouchedAt > TRACE_GUARD_TTL_MS) {
      traceGuards.delete(traceId);
    }
  }
}

function getTraceGuard(traceId: string): TraceGuardState {
  pruneTraceGuards();
  const existing = traceGuards.get(traceId);
  if (existing) {
    existing.lastTouchedAt = Date.now();
    return existing;
  }
  const created: TraceGuardState = {
    activeDepth: 0,
    callCount: 0,
    lastTouchedAt: Date.now(),
    taskHashes: new Map(),
    pairWindows: new Map(),
  };
  traceGuards.set(traceId, created);
  return created;
}

function summarizeAssistantText(params: {
  sessionKey: string;
  maxChars?: number;
}): string {
  const { entry, storePath } = loadSessionEntry(params.sessionKey);
  if (!entry?.sessionId) {
    return "";
  }
  const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "assistant") {
      continue;
    }
    const content = message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((item) =>
          item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
            ? ((item as { text: string }).text ?? "")
            : "",
        )
        .filter(Boolean)
        .join("\n");
    }
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }
    const maxChars = Math.max(40, params.maxChars ?? 800);
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
  }
  return "";
}

async function invokeGatewayHandler<T>(params: {
  method: string;
  handler: GatewayRequestHandlers[string];
  input: Record<string, unknown>;
  base: {
    context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
    client: Parameters<GatewayRequestHandlers[string]>[0]["client"];
    isWebchatConnect: Parameters<GatewayRequestHandlers[string]>[0]["isWebchatConnect"];
  };
}): Promise<{ ok: true; payload: T } | { ok: false; error: ReturnType<typeof errorShape> }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true; payload: T } | { ok: false; error: ReturnType<typeof errorShape> }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const respond: RespondFn = (ok, payload, error) => {
      if (ok) {
        finish({ ok: true, payload: payload as T });
      } else {
        finish({
          ok: false,
          error: isGatewayErrorShape(error)
            ? error
            : errorShape(
                ErrorCodes.UNAVAILABLE,
                formatUnknownError(error, `${params.method} failed`),
              ),
        });
      }
    };
    const reqId = `${params.method}:${randomUUID()}`;
    const reqMethod = params.method;
    const run = params.handler({
      req: {
        type: "req",
        id: reqId,
        method: reqMethod,
      },
      params: params.input,
      context: params.base.context,
      client: params.base.client,
      isWebchatConnect: params.base.isWebchatConnect,
      respond,
    });
    void Promise.resolve(run)
      .then(() => {
        if (!settled) {
          finish({
            ok: false,
            error: errorShape(ErrorCodes.UNAVAILABLE, `${params.method} returned without response`),
          });
        }
      })
      .catch((err: unknown) => {
        finish({
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            formatUnknownError(err, `${params.method} failed`),
          ),
        });
      });
  });
}

function isGatewayErrorShape(value: unknown): value is { code: string; message: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": ({ params, respond }) => {
    if (!validateAgentsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const result = listAgentsForGateway(cfg);
    respond(true, result, undefined);
  },
  "artifacts.publish": ({ params, respond }) => {
    if (!validateArtifactsPublishParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid artifacts.publish params: ${formatValidationErrors(
            validateArtifactsPublishParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const createdByAgentId = ensureKnownAgentId(params.createdByAgentId, cfg);
    if (!createdByAgentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown createdByAgentId"));
      return;
    }
    const traceId = sanitizeTraceId(String(params.traceId ?? ""));
    const kind =
      typeof params.kind === "string" && params.kind.trim() ? params.kind.trim() : undefined;
    const ttlDays =
      typeof params.ttlDays === "number" && Number.isFinite(params.ttlDays)
        ? Math.max(1, Math.floor(params.ttlDays))
        : undefined;
    const requestId =
      typeof params.requestId === "string" && params.requestId.trim()
        ? params.requestId.trim()
        : undefined;
    const published = publishArtifact({
      cfg,
      content:
        typeof params.content === "string" || (params.content && typeof params.content === "object")
          ? (params.content as string | Record<string, unknown>)
          : String(params.content ?? ""),
      createdByAgentId,
      traceId,
      kind,
      ttlDays,
      requestId,
    });
    respond(
      true,
      {
        artifactId: published.artifactId,
        kind: published.metadata.kind,
        traceId: published.metadata.traceId,
        sizeBytes: published.metadata.sizeBytes,
        payloadPath: published.payloadPath,
        metaPath: published.metaPath,
      },
      undefined,
    );
  },
  "artifacts.fetch": ({ params, respond }) => {
    if (!validateArtifactsFetchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid artifacts.fetch params: ${formatValidationErrors(validateArtifactsFetchParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const fetchedByAgentId = ensureKnownAgentId(params.fetchedByAgentId, cfg);
    if (!fetchedByAgentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown fetchedByAgentId"));
      return;
    }
    try {
      const traceId = sanitizeTraceId(String(params.traceId ?? ""));
      const requestId =
        typeof params.requestId === "string" && params.requestId.trim()
          ? params.requestId.trim()
          : undefined;
      const result = fetchArtifact({
        cfg,
        artifactId: String(params.artifactId ?? ""),
        fetchedByAgentId,
        traceId,
        requestId,
      });
      respond(
        true,
        {
          artifactId: result.artifactId,
          kind: result.metadata.kind,
          traceId,
          metadata: result.metadata,
          content: result.content,
          raw: result.raw,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "agents.message": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!validateAgentsMessageParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.message params: ${formatValidationErrors(validateAgentsMessageParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const fromAgentId = ensureKnownAgentId(params.fromAgentId, cfg);
    const toAgentId = ensureKnownAgentId(params.toAgentId, cfg);
    if (!fromAgentId || !toAgentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const traceId = sanitizeTraceId(String(params.traceId ?? ""));
    const sourceRunId =
      typeof params.sourceRunId === "string" && params.sourceRunId.trim()
        ? params.sourceRunId.trim()
        : undefined;
    const priority =
      typeof params.priority === "string" && params.priority.trim()
        ? params.priority.trim().toLowerCase()
        : "normal";
    const sessionKeyRaw =
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : `agent:${toAgentId}:inbox`;
    const initialRefs = normalizeArtifactRefs(params.artifactRefs);
    const compacted = maybeAutoPublishLongPayload({
      cfg,
      fromAgentId,
      toAgentId,
      traceId,
      message: String(params.message ?? "").trim(),
      artifactRefs: initialRefs,
      requestId: sourceRunId,
    });
    writeHandoffBrief({
      cfg,
      traceId,
      fromAgentId,
      toAgentId,
      summary:
        compacted.message.length > 480
          ? `${compacted.message.slice(0, 479)}…`
          : compacted.message,
      artifactRefs: compacted.artifactRefs,
      decision: "inbox_message",
    });

    const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKeyRaw });
    await updateSessionStore(target.storePath, (store) => {
      const existing = store[target.canonicalKey];
      if (!existing) {
        store[target.canonicalKey] = {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          label: "inbox",
        };
      } else {
        store[target.canonicalKey] = {
          ...existing,
          updatedAt: Date.now(),
          label: existing.label ?? "inbox",
        };
      }
    });

    const injected = await invokeGatewayHandler<{ ok?: boolean; messageId?: string }>({
      method: "chat.inject",
      handler: chatHandlers["chat.inject"],
      input: {
        sessionKey: target.canonicalKey,
        message: renderDelegationMessage({
          fromAgentId,
          message: compacted.message,
          artifactRefs: compacted.artifactRefs,
          traceId,
        }),
        label: `${fromAgentId}:${priority}`,
      },
      base: {
        context,
        client,
        isWebchatConnect,
      },
    });
    if (!injected.ok) {
      respond(false, undefined, injected.error);
      return;
    }

    observeAgentMessage(
      {
        traceId,
        fromAgentId,
        toAgentId,
        sessionKey: target.canonicalKey,
        artifactIds: compacted.artifactRefs.map((ref) => ref.artifactId),
        requestId: sourceRunId,
        priority,
      },
      cfg,
    );

    respond(
      true,
      {
        ok: true,
        traceId,
        sessionKey: target.canonicalKey,
        messageId: injected.payload?.messageId,
        artifactRefs: compacted.artifactRefs,
      },
      undefined,
    );
  },
  "agents.call": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!validateAgentsCallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.call params: ${formatValidationErrors(validateAgentsCallParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const fromAgentId = ensureKnownAgentId(params.fromAgentId, cfg);
    const toAgentId = ensureKnownAgentId(params.toAgentId, cfg);
    if (!fromAgentId || !toAgentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }

    const traceId = sanitizeTraceId(String(params.traceId ?? ""));
    const sourceRunId =
      typeof params.sourceRunId === "string" && params.sourceRunId.trim()
        ? params.sourceRunId.trim()
        : undefined;
    const limits = resolveDelegationLimits(
      cfg,
      params.limits && typeof params.limits === "object"
        ? (params.limits as Record<string, unknown>)
        : undefined,
    );
    const sessionKey =
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : `agent:${toAgentId}:workflow:${sanitizeWorkflowTraceToken(traceId)}`;

    const initialRefs = normalizeArtifactRefs(params.artifactRefs);
    const message = String(params.message ?? "").trim();
    const taskHash = createHash("sha256")
      .update(
        JSON.stringify({
          toAgentId,
          message: message.replace(/\s+/g, " ").trim(),
          artifactIds: initialRefs.map((entry) => entry.artifactId).toSorted(),
          sessionKey,
        }),
        "utf8",
      )
      .digest("hex");

    const guard = getTraceGuard(traceId);
    const now = Date.now();
    guard.lastTouchedAt = now;
    for (const [hash, ts] of guard.taskHashes.entries()) {
      if (now - ts > limits.dedupeWindowMs) {
        guard.taskHashes.delete(hash);
      }
    }
    const pairKey = `${fromAgentId}->${toAgentId}`;
    const recentPairCalls = (guard.pairWindows.get(pairKey) ?? []).filter(
      (ts) => now - ts <= 60_000,
    );
    guard.pairWindows.set(pairKey, recentPairCalls);

    if (guard.activeDepth >= limits.maxDepth) {
      const blockedResult = {
        status: "blocked" as const,
        traceId,
        sessionKey,
        taskHash,
        summary: `delegation depth limit reached (${limits.maxDepth})`,
        artifacts: initialRefs,
        error: "maxDepth exceeded",
      };
      observeAgentCallError(
        {
          traceId,
          fromAgentId,
          toAgentId,
          sessionKey,
          taskHash,
          error: blockedResult.error,
          requestId: sourceRunId,
        },
        cfg,
      );
      respond(true, blockedResult, undefined);
      return;
    }

    if (guard.callCount >= limits.maxCallsPerTrace) {
      const blockedResult = {
        status: "blocked" as const,
        traceId,
        sessionKey,
        taskHash,
        summary: `trace call limit reached (${limits.maxCallsPerTrace})`,
        artifacts: initialRefs,
        error: "maxCallsPerTrace exceeded",
      };
      observeAgentCallError(
        {
          traceId,
          fromAgentId,
          toAgentId,
          sessionKey,
          taskHash,
          error: blockedResult.error,
          requestId: sourceRunId,
        },
        cfg,
      );
      respond(true, blockedResult, undefined);
      return;
    }

    const previousTaskTs = guard.taskHashes.get(taskHash);
    if (typeof previousTaskTs === "number" && now - previousTaskTs <= limits.dedupeWindowMs) {
      respond(
        true,
        {
          status: "deduped",
          traceId,
          sessionKey,
          taskHash,
          summary: "identical delegated task deduped in active window",
          artifacts: initialRefs,
        },
        undefined,
      );
      return;
    }

    if (recentPairCalls.length >= limits.pairRateLimitPerMinute) {
      const blockedResult = {
        status: "blocked" as const,
        traceId,
        sessionKey,
        taskHash,
        summary: `pair rate limit reached (${limits.pairRateLimitPerMinute}/min)`,
        artifacts: initialRefs,
        error: "pairRateLimitPerMinute exceeded",
      };
      observeAgentCallError(
        {
          traceId,
          fromAgentId,
          toAgentId,
          sessionKey,
          taskHash,
          error: blockedResult.error,
          requestId: sourceRunId,
        },
        cfg,
      );
      respond(true, blockedResult, undefined);
      return;
    }

    guard.activeDepth += 1;
    guard.callCount += 1;
    guard.taskHashes.set(taskHash, now);
    guard.pairWindows.set(pairKey, [...recentPairCalls, now]);
    let resultStatus: "ok" | "error" | "timeout" = "ok";
    const startedAt = Date.now();
    try {
      const compacted = maybeAutoPublishLongPayload({
        cfg,
        fromAgentId,
        toAgentId,
        traceId,
        message,
        artifactRefs: initialRefs,
        requestId: sourceRunId,
      });
      const runInputMessage = renderDelegationMessage({
        fromAgentId,
        message: compacted.message,
        artifactRefs: compacted.artifactRefs,
        traceId,
      });

      observeAgentCallStart(
        {
          traceId,
          fromAgentId,
          toAgentId,
          sessionKey,
          limits,
          taskHash,
          artifactIds: compacted.artifactRefs.map((ref) => ref.artifactId),
          requestId: sourceRunId,
        },
        cfg,
      );

      const callResult = await invokeGatewayHandler<{ runId?: string }>({
        method: "agent",
        handler: agentHandlers.agent,
        input: {
          message: runInputMessage,
          sessionKey,
          agentId: toAgentId,
          idempotencyKey: randomUUID(),
          deliver: false,
          timeout: Math.ceil(limits.timeoutMs / 1000),
        },
        base: {
          context,
          client,
          isWebchatConnect,
        },
      });
      if (!callResult.ok || !callResult.payload?.runId) {
        const errorMessage = callResult.ok
          ? "agent call returned without runId"
          : callResult.error.message;
        resultStatus = "error";
        observeAgentCallError(
          {
            traceId,
            fromAgentId,
            toAgentId,
            sessionKey,
            taskHash,
            error: errorMessage,
            requestId: sourceRunId,
          },
          cfg,
        );
        observeAgentCallEnd(
          {
            traceId,
            fromAgentId,
            toAgentId,
            sessionKey,
            taskHash,
            status: resultStatus,
            latencyMs: Date.now() - startedAt,
            artifactIds: compacted.artifactRefs.map((entry) => entry.artifactId),
            requestId: sourceRunId,
          },
          cfg,
        );
        respond(
          true,
          {
            status: "error",
            traceId,
            sessionKey,
            taskHash,
            summary: "delegated call failed to start",
            artifacts: compacted.artifactRefs,
            error: errorMessage,
          },
          undefined,
        );
        return;
      }
      const runId = callResult.payload.runId;
      const snapshot = await waitForAgentJob({
        runId,
        timeoutMs: limits.timeoutMs,
      });
      if (!snapshot) {
        resultStatus = "timeout";
      } else if (snapshot.status !== "ok") {
        resultStatus = "error";
      }

      const summaryText = summarizeAssistantText({ sessionKey, maxChars: 800 });
      const summary =
        summaryText ||
        (resultStatus === "ok"
          ? "delegated call completed"
          : resultStatus === "timeout"
            ? "delegated call timed out"
            : snapshot?.error || "delegated call failed");

      const summaryArtifact = publishArtifact({
        cfg,
        content: {
          traceId,
          fromAgentId,
          toAgentId,
          runId,
          status: resultStatus,
          sessionKey,
          summary,
          sourceArtifacts: compacted.artifactRefs,
        },
        createdByAgentId: toAgentId,
        traceId,
        kind: "application/json",
        requestId: sourceRunId,
      });
      const artifacts: ArtifactRef[] = [
        ...compacted.artifactRefs,
        {
          artifactId: summaryArtifact.artifactId,
          kind: summaryArtifact.metadata.kind,
          note: "delegation summary",
        },
      ];
      writeHandoffBrief({
        cfg,
        traceId,
        fromAgentId,
        toAgentId,
        summary,
        artifactRefs: artifacts,
        decision: resultStatus,
      });

      if (resultStatus !== "ok") {
        observeAgentCallError(
          {
            traceId,
            fromAgentId,
            toAgentId,
            sessionKey,
            taskHash,
            error: snapshot?.error ?? resultStatus,
            requestId: sourceRunId,
          },
          cfg,
        );
      }
      observeAgentCallEnd(
        {
          traceId,
          fromAgentId,
          toAgentId,
          sessionKey,
          taskHash,
          status: resultStatus,
          latencyMs: Date.now() - startedAt,
          artifactIds: artifacts.map((entry) => entry.artifactId),
          requestId: sourceRunId,
        },
        cfg,
      );

      respond(
        true,
        {
          status: resultStatus,
          traceId,
          sessionKey,
          taskHash,
          runId,
          summary: summary.length > 800 ? `${summary.slice(0, 799)}…` : summary,
          artifacts,
          error: resultStatus === "ok" ? undefined : snapshot?.error ?? resultStatus,
        },
        undefined,
      );
    } finally {
      guard.activeDepth = Math.max(0, guard.activeDepth - 1);
      guard.lastTouchedAt = Date.now();
      pruneTraceGuards();
    }
  },
  "agents.create": async ({ params, respond }) => {
    if (!validateAgentsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.create params: ${formatValidationErrors(
            validateAgentsCreateParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const rawName = String(params.name ?? "").trim();
    const agentId = normalizeAgentId(rawName);
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" is reserved`),
      );
      return;
    }

    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`),
      );
      return;
    }

    const workspaceDir = resolveUserPath(String(params.workspace ?? "").trim());

    // Resolve agentDir against the config we're about to persist (vs the pre-write config),
    // so subsequent resolutions can't disagree about the agent's directory.
    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: rawName,
      workspace: workspaceDir,
    });
    const agentDir = resolveAgentDir(nextConfig, agentId);
    nextConfig = applyAgentConfig(nextConfig, { agentId, agentDir });

    // Ensure workspace & transcripts exist BEFORE writing config so a failure
    // here does not leave a broken config entry behind.
    const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
    await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: !skipBootstrap });
    await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

    await writeConfigFile(nextConfig);

    // Always write Name to IDENTITY.md; optionally include emoji/avatar.
    const safeName = sanitizeIdentityLine(rawName);
    const emoji = resolveOptionalStringParam(params.emoji);
    const avatar = resolveOptionalStringParam(params.avatar);
    const identityPath = path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME);
    const lines = [
      "",
      `- Name: ${safeName}`,
      ...(emoji ? [`- Emoji: ${sanitizeIdentityLine(emoji)}`] : []),
      ...(avatar ? [`- Avatar: ${sanitizeIdentityLine(avatar)}`] : []),
      "",
    ];
    await fs.appendFile(identityPath, lines.join("\n"), "utf-8");

    respond(true, { ok: true, agentId, name: rawName, workspace: workspaceDir }, undefined);
  },
  "agents.update": async ({ params, respond }) => {
    if (!validateAgentsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.update params: ${formatValidationErrors(
            validateAgentsUpdateParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const agentId = normalizeAgentId(String(params.agentId ?? ""));
    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }

    const workspaceDir =
      typeof params.workspace === "string" && params.workspace.trim()
        ? resolveUserPath(params.workspace.trim())
        : undefined;

    const model = resolveOptionalStringParam(params.model);
    const avatar = resolveOptionalStringParam(params.avatar);

    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      ...(typeof params.name === "string" && params.name.trim()
        ? { name: params.name.trim() }
        : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model ? { model } : {}),
    });

    await writeConfigFile(nextConfig);

    if (workspaceDir) {
      const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
      await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: !skipBootstrap });
    }

    if (avatar) {
      const workspace = workspaceDir ?? resolveAgentWorkspaceDir(nextConfig, agentId);
      await fs.mkdir(workspace, { recursive: true });
      const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
      await fs.appendFile(identityPath, `\n- Avatar: ${sanitizeIdentityLine(avatar)}\n`, "utf-8");
    }

    respond(true, { ok: true, agentId }, undefined);
  },
  "agents.delete": async ({ params, respond }) => {
    if (!validateAgentsDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.delete params: ${formatValidationErrors(
            validateAgentsDeleteParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const agentId = normalizeAgentId(String(params.agentId ?? ""));
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" cannot be deleted`),
      );
      return;
    }
    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
      );
      return;
    }

    const deleteFiles = typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

    const result = pruneAgentConfig(cfg, agentId);
    await writeConfigFile(result.config);

    if (deleteFiles) {
      await Promise.all([
        moveToTrashBestEffort(workspaceDir),
        moveToTrashBestEffort(agentDir),
        moveToTrashBestEffort(sessionsDir),
      ]);
    }

    respond(true, { ok: true, agentId, removedBindings: result.removedBindings }, undefined);
  },
  "agents.files.list": async ({ params, respond }) => {
    if (!validateAgentsFilesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.list params: ${formatValidationErrors(
            validateAgentsFilesListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    let hideBootstrap = false;
    try {
      hideBootstrap = await isWorkspaceOnboardingCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const files = await listAgentFiles(workspaceDir, { hideBootstrap });
    respond(true, { agentId, workspace: workspaceDir, files }, undefined);
  },
  "agents.files.get": async ({ params, respond }) => {
    if (!validateAgentsFilesGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.get params: ${formatValidationErrors(
            validateAgentsFilesGetParams.errors,
          )}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const filePath = path.join(workspaceDir, name);
    const meta = await statFile(filePath);
    if (!meta) {
      respond(
        true,
        {
          agentId,
          workspace: workspaceDir,
          file: { name, path: filePath, missing: true },
        },
        undefined,
      );
      return;
    }
    const content = await fs.readFile(filePath, "utf-8");
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta.size,
          updatedAtMs: meta.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond }) => {
    if (!validateAgentsFilesSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.set params: ${formatValidationErrors(
            validateAgentsFilesSetParams.errors,
          )}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    await fs.mkdir(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, name);
    const content = String(params.content ?? "");
    await fs.writeFile(filePath, content, "utf-8");
    const meta = await statFile(filePath);
    respond(
      true,
      {
        ok: true,
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
};
