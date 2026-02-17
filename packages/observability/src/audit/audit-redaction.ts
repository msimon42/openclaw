import type { AuditEvent } from "./audit-types.js";
import { stableHash } from "../util/stable-hash.js";

const SECRET_KEY_RE =
  /(?:^|_|-)(?:api[_-]?key|token|secret|password|authorization|cookie|set-cookie|x-api-key)(?:$|_|-)/i;
const ENV_STYLE_SECRET_KEY_RE = /^(?:[A-Z0-9_]+(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)$/;
const PROMPT_FIELD_RE = /^(prompt|response|messages?|input|output|body|content)$/i;

export type RedactionMode = "strict" | "debug";

export type RedactionOptions = {
  mode?: RedactionMode;
  maxDebugStringChars?: number;
  hashPromptResponse?: boolean;
  redactHeaderKeys?: string[];
};

export const DEFAULT_REDACTION_OPTIONS: Required<RedactionOptions> = {
  mode: "strict",
  maxDebugStringChars: 512,
  hashPromptResponse: true,
  redactHeaderKeys: ["authorization", "cookie", "set-cookie", "x-api-key"],
};

function isSecretKey(key: string, options: Required<RedactionOptions>): boolean {
  const normalized = key.trim();
  if (!normalized) {
    return false;
  }
  if (ENV_STYLE_SECRET_KEY_RE.test(normalized)) {
    return true;
  }
  if (SECRET_KEY_RE.test(normalized)) {
    return true;
  }
  return options.redactHeaderKeys.some((value) => value.toLowerCase() === normalized.toLowerCase());
}

function truncateDebugString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}

function toHashedText(value: string): { hash: string; length: number } {
  return {
    hash: stableHash(value),
    length: value.length,
  };
}

function redactValueInner(
  value: unknown,
  options: Required<RedactionOptions>,
  keyHint?: string,
): unknown {
  if (typeof value === "string") {
    if (keyHint && isSecretKey(keyHint, options)) {
      return "[REDACTED]";
    }
    if (keyHint && PROMPT_FIELD_RE.test(keyHint) && options.hashPromptResponse) {
      return toHashedText(value);
    }
    if (options.mode === "strict") {
      return toHashedText(value);
    }
    return truncateDebugString(value, options.maxDebugStringChars);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValueInner(entry, options));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key, options)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (typeof entry === "string" && PROMPT_FIELD_RE.test(key) && options.hashPromptResponse) {
      out[key] = toHashedText(entry);
      continue;
    }
    out[key] = redactValueInner(entry, options, key);
  }
  return out;
}

export function redactValue(value: unknown, options?: RedactionOptions): unknown {
  const merged: Required<RedactionOptions> = {
    ...DEFAULT_REDACTION_OPTIONS,
    ...options,
  };
  return redactValueInner(value, merged);
}

export function redactAuditEvent(event: AuditEvent, options?: RedactionOptions): AuditEvent {
  return {
    ...event,
    payload: redactValue(event.payload, options) as Record<string, unknown>,
  };
}
