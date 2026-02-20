import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { ensureMultiAgentSharedLayout } from "./workspace-layout.js";
import { observeArtifactFetch, observeArtifactPublish } from "../infra/observability.js";

const ARTIFACT_ID_RE = /^art_[a-f0-9]{64}$/;
const ARTIFACT_SCHEMA_VERSION = "1.0";
const DEFAULT_ARTIFACT_KIND_TEXT = "text/plain";
const DEFAULT_ARTIFACT_KIND_JSON = "application/json";

export type ArtifactRef = {
  artifactId: string;
  kind: string;
  note?: string;
};

export type ArtifactMetadata = {
  artifactId: string;
  hash: string;
  createdAt: string;
  createdByAgentId: string;
  traceId: string;
  kind: string;
  sizeBytes: number;
  ttlDays?: number;
  schemaVersion: string;
  payloadFile: string;
};

export type PublishedArtifact = {
  artifactId: string;
  metadata: ArtifactMetadata;
  payloadPath: string;
  metaPath: string;
};

export type FetchArtifactResult = {
  artifactId: string;
  metadata: ArtifactMetadata;
  content: string | Record<string, unknown>;
  raw: string;
  payloadPath: string;
  metaPath: string;
};

function isTextKind(kind: string): boolean {
  return kind.trim().toLowerCase().startsWith("text/");
}

function normalizeTraceId(traceId: string): string {
  const trimmed = traceId.trim();
  return trimmed || `trace_${Date.now().toString(36)}`;
}

function sanitizeArtifactId(artifactId: string): string {
  const trimmed = artifactId.trim().toLowerCase();
  if (!ARTIFACT_ID_RE.test(trimmed)) {
    throw new Error(`invalid artifactId: ${artifactId}`);
  }
  return trimmed;
}

function sanitizeFileToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function readMetadata(metaPath: string): ArtifactMetadata | null {
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as ArtifactMetadata;
    if (
      typeof parsed?.artifactId === "string" &&
      typeof parsed?.hash === "string" &&
      typeof parsed?.payloadFile === "string"
    ) {
      return parsed;
    }
  } catch {
    // Ignore invalid metadata and rewrite a new one.
  }
  return null;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, filePath);
}

export function publishArtifact(params: {
  cfg?: OpenClawConfig;
  content: string | Record<string, unknown>;
  createdByAgentId: string;
  traceId: string;
  kind?: string;
  ttlDays?: number;
  requestId?: string;
}): PublishedArtifact {
  const shared = ensureMultiAgentSharedLayout(params.cfg);
  const kind =
    params.kind?.trim() ||
    (typeof params.content === "string" ? DEFAULT_ARTIFACT_KIND_TEXT : DEFAULT_ARTIFACT_KIND_JSON);
  const isTextPayload = typeof params.content === "string" && isTextKind(kind);
  let raw = "";
  if (isTextPayload && typeof params.content === "string") {
    raw = params.content;
  } else {
    raw = JSON.stringify(params.content as Record<string, unknown>, null, 2);
  }
  const bytes = Buffer.from(raw, "utf8");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const artifactId = `art_${hash}`;
  const payloadFile = `${artifactId}${isTextPayload ? ".txt" : ".json"}`;
  const payloadPath = path.join(shared.artifactsDir, payloadFile);
  const metaPath = path.join(shared.artifactsDir, `${artifactId}.meta.json`);

  if (!fs.existsSync(payloadPath)) {
    fs.mkdirSync(shared.artifactsDir, { recursive: true });
    fs.writeFileSync(payloadPath, raw, "utf-8");
  }

  const existingMeta = readMetadata(metaPath);
  const metadata: ArtifactMetadata =
    existingMeta ??
    {
      artifactId,
      hash,
      createdAt: new Date().toISOString(),
      createdByAgentId: params.createdByAgentId.trim() || "main",
      traceId: normalizeTraceId(params.traceId),
      kind,
      sizeBytes: bytes.byteLength,
      ttlDays: params.ttlDays,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      payloadFile,
    };

  if (!existingMeta) {
    writeJsonAtomic(metaPath, metadata);
  }

  observeArtifactPublish(
    {
      traceId: metadata.traceId,
      agentId: metadata.createdByAgentId,
      artifactId,
      kind: metadata.kind,
      sizeBytes: metadata.sizeBytes,
      requestId: params.requestId,
    },
    params.cfg,
  );

  return {
    artifactId,
    metadata,
    payloadPath,
    metaPath,
  };
}

function resolvePayloadPath(sharedArtifactsDir: string, metadata: ArtifactMetadata): string {
  const named = path.join(sharedArtifactsDir, metadata.payloadFile);
  if (fs.existsSync(named)) {
    return named;
  }
  const txt = path.join(sharedArtifactsDir, `${metadata.artifactId}.txt`);
  if (fs.existsSync(txt)) {
    return txt;
  }
  return path.join(sharedArtifactsDir, `${metadata.artifactId}.json`);
}

export function fetchArtifact(params: {
  cfg?: OpenClawConfig;
  artifactId: string;
  fetchedByAgentId: string;
  traceId: string;
  requestId?: string;
}): FetchArtifactResult {
  const shared = ensureMultiAgentSharedLayout(params.cfg);
  const artifactId = sanitizeArtifactId(params.artifactId);
  const metaPath = path.join(shared.artifactsDir, `${artifactId}.meta.json`);
  if (!fs.existsSync(metaPath)) {
    throw new Error(`artifact not found: ${artifactId}`);
  }
  const metadata = readMetadata(metaPath);
  if (!metadata) {
    throw new Error(`invalid artifact metadata: ${artifactId}`);
  }
  const payloadPath = resolvePayloadPath(shared.artifactsDir, metadata);
  if (!fs.existsSync(payloadPath)) {
    throw new Error(`artifact payload missing: ${artifactId}`);
  }
  const raw = fs.readFileSync(payloadPath, "utf-8");
  const content: string | Record<string, unknown> = isTextKind(metadata.kind)
    ? raw
    : (JSON.parse(raw) as Record<string, unknown>);

  observeArtifactFetch(
    {
      traceId: normalizeTraceId(params.traceId),
      agentId: params.fetchedByAgentId.trim() || "main",
      artifactId,
      requestId: params.requestId,
    },
    params.cfg,
  );

  return {
    artifactId,
    metadata,
    content,
    raw,
    payloadPath,
    metaPath,
  };
}

export function writeHandoffBrief(params: {
  cfg?: OpenClawConfig;
  traceId: string;
  fromAgentId: string;
  toAgentId: string;
  summary: string;
  artifactRefs?: ArtifactRef[];
  riskTier?: "low" | "medium" | "high" | "critical";
  decision?: string;
}): string {
  const shared = ensureMultiAgentSharedLayout(params.cfg);
  const traceId = sanitizeFileToken(params.traceId) || "trace";
  const fromAgentId = sanitizeFileToken(params.fromAgentId) || "from";
  const toAgentId = sanitizeFileToken(params.toAgentId) || "to";
  const filePath = path.join(shared.briefsDir, `${traceId}-${fromAgentId}-to-${toAgentId}.json`);
  writeJsonAtomic(filePath, {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    traceId: params.traceId,
    fromAgentId: params.fromAgentId,
    toAgentId: params.toAgentId,
    summary: params.summary,
    artifactRefs: params.artifactRefs ?? [],
    riskTier: params.riskTier,
    decision: params.decision,
  });
  return filePath;
}

export function maybeAutoPublishLongPayload(params: {
  cfg?: OpenClawConfig;
  fromAgentId: string;
  toAgentId: string;
  traceId: string;
  message: string;
  artifactRefs?: ArtifactRef[];
  thresholdChars?: number;
  requestId?: string;
}): {
  message: string;
  artifactRefs: ArtifactRef[];
  autoPublishedArtifactId?: string;
} {
  const configuredThreshold = params.cfg?.agents?.defaults?.multiAgent?.artifactAutoPublishChars;
  const threshold =
    typeof params.thresholdChars === "number" && Number.isFinite(params.thresholdChars)
      ? Math.max(200, Math.floor(params.thresholdChars))
      : typeof configuredThreshold === "number" && Number.isFinite(configuredThreshold)
        ? Math.max(200, Math.floor(configuredThreshold))
        : 2000;
  if (params.message.length <= threshold) {
    return {
      message: params.message,
      artifactRefs: params.artifactRefs ?? [],
    };
  }

  const published = publishArtifact({
    cfg: params.cfg,
    content: params.message,
    createdByAgentId: params.fromAgentId,
    traceId: params.traceId,
    kind: "text/plain",
    requestId: params.requestId,
  });
  const refs = [
    ...(params.artifactRefs ?? []),
    {
      artifactId: published.artifactId,
      kind: published.metadata.kind,
      note: "auto-published long delegation payload",
    },
  ];
  const compactMessage =
    `Payload was compacted to artifact ref due to size (${params.message.length} chars). ` +
    `Use fetch_artifact("${published.artifactId}") for full details.`;
  writeHandoffBrief({
    cfg: params.cfg,
    traceId: params.traceId,
    fromAgentId: params.fromAgentId,
    toAgentId: params.toAgentId,
    summary: compactMessage,
    artifactRefs: refs,
    decision: "auto-compact",
  });
  return {
    message: compactMessage,
    artifactRefs: refs,
    autoPublishedArtifactId: published.artifactId,
  };
}
