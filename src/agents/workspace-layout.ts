import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";

const DEFAULT_WORKSPACES_ROOT = path.resolve(process.cwd(), "workspaces");

function resolveConfiguredRoot(cfg?: OpenClawConfig): string | undefined {
  const root = cfg?.agents?.defaults?.multiAgent?.workspaceRoot;
  if (typeof root !== "string") {
    return undefined;
  }
  const trimmed = root.trim();
  return trimmed ? resolveUserPath(trimmed) : undefined;
}

export function resolveMultiAgentWorkspacesRoot(cfg?: OpenClawConfig): string {
  return resolveConfiguredRoot(cfg) ?? DEFAULT_WORKSPACES_ROOT;
}

export function resolveMultiAgentSharedRoot(cfg?: OpenClawConfig): string {
  return path.join(resolveMultiAgentWorkspacesRoot(cfg), "_shared");
}

export function resolveMultiAgentAgentWorkspace(agentId: string, cfg?: OpenClawConfig): string {
  const normalized = normalizeAgentId(agentId);
  return path.join(resolveMultiAgentWorkspacesRoot(cfg), "agents", normalized);
}

function writeFileIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

export function ensureMultiAgentSharedLayout(cfg?: OpenClawConfig): {
  workspacesRoot: string;
  sharedRoot: string;
  artifactsDir: string;
  briefsDir: string;
  boardPath: string;
} {
  const workspacesRoot = resolveMultiAgentWorkspacesRoot(cfg);
  const sharedRoot = resolveMultiAgentSharedRoot(cfg);
  const artifactsDir = path.join(sharedRoot, "artifacts");
  const briefsDir = path.join(sharedRoot, "briefs");
  const boardPath = path.join(sharedRoot, "BOARD.md");

  fs.mkdirSync(path.join(workspacesRoot, "agents"), { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(briefsDir, { recursive: true });
  writeFileIfMissing(
    boardPath,
    [
      "# Multi-Agent Board",
      "",
      "- Use compact handoff briefs and artifact refs.",
      "- Avoid forwarding raw long transcripts between agents.",
      "",
    ].join("\n"),
  );

  return { workspacesRoot, sharedRoot, artifactsDir, briefsDir, boardPath };
}
