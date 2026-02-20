import path from "node:path";
import type { OpenClawConfig } from "./types.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";

export type DuplicateWorkspaceDir = {
  workspaceDir: string;
  agentIds: string[];
};

function canonicalizeWorkspaceDir(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  if (process.platform === "darwin" || process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

export function findDuplicateAgentWorkspaces(cfg: OpenClawConfig): DuplicateWorkspaceDir[] {
  const byPath = new Map<string, { workspaceDir: string; agentIds: string[] }>();
  for (const agentId of listAgentIds(cfg)) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = canonicalizeWorkspaceDir(workspaceDir);
    const existing = byPath.get(key);
    if (existing) {
      existing.agentIds.push(agentId);
    } else {
      byPath.set(key, { workspaceDir, agentIds: [agentId] });
    }
  }
  return [...byPath.values()].filter((entry) => entry.agentIds.length > 1);
}

export function formatDuplicateWorkspaceWarning(dups: DuplicateWorkspaceDir[]): string {
  return [
    "Multiple agents share the same workspace directory.",
    "This can cause context cross-talk and prompt bleed between isolated agents.",
    "",
    ...dups.map((dup) => `- ${dup.workspaceDir}: ${dup.agentIds.map((id) => `"${id}"`).join(", ")}`),
  ].join("\n");
}
