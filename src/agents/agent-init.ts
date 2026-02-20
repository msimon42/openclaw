import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../config/config.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "../config/agent-dirs.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { listAgentIds, resolveAgentDir } from "./agent-scope.js";
import {
  ensureMultiAgentSharedLayout,
  resolveMultiAgentAgentWorkspace,
  resolveMultiAgentWorkspacesRoot,
} from "./workspace-layout.js";

const TEMPLATE_NAMES = ["admin", "worker", "social", "research"] as const;

export type AgentInitTemplateName = (typeof TEMPLATE_NAMES)[number];

export type InitAgentWorkspaceResult = {
  agentId: string;
  template: AgentInitTemplateName;
  workspaceDir: string;
  workspacesRoot: string;
  sharedRoot: string;
  created: string[];
  skipped: string[];
  forced: string[];
};

function normalizeTemplateName(raw: string): AgentInitTemplateName | null {
  const value = raw.trim().toLowerCase();
  if (value === "admin" || value === "worker" || value === "social" || value === "research") {
    return value;
  }
  return null;
}

function resolveTemplateRoot(): string {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "templates"),
    path.resolve(srcDir, "..", "..", "templates"),
    path.resolve(srcDir, "..", "..", "..", "templates"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  throw new Error(`templates directory not found (checked: ${candidates.join(", ")})`);
}

function resolveTemplateDir(name: AgentInitTemplateName): string {
  const templateRoot = resolveTemplateRoot();
  const dir = path.join(templateRoot, `agent-${name}`);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`template not found: ${name} (${dir})`);
  }
  return dir;
}

function writeFileWithMode(params: {
  filePath: string;
  content: string;
  force?: boolean;
  created: string[];
  skipped: string[];
  forced: string[];
}) {
  const exists = fs.existsSync(params.filePath);
  if (!exists) {
    fs.mkdirSync(path.dirname(params.filePath), { recursive: true });
    fs.writeFileSync(params.filePath, params.content, "utf-8");
    params.created.push(params.filePath);
    return;
  }
  if (!params.force) {
    params.skipped.push(params.filePath);
    return;
  }
  fs.writeFileSync(params.filePath, params.content, "utf-8");
  params.forced.push(params.filePath);
}

function ensureDirWithMode(params: {
  dirPath: string;
  force?: boolean;
  created: string[];
  skipped: string[];
  forced: string[];
}) {
  const exists = fs.existsSync(params.dirPath);
  if (!exists) {
    fs.mkdirSync(params.dirPath, { recursive: true });
    params.created.push(params.dirPath);
    return;
  }
  if (params.force) {
    params.forced.push(params.dirPath);
  } else {
    params.skipped.push(params.dirPath);
  }
}

function canonicalizePath(p: string): string {
  const resolved = path.resolve(p);
  if (process.platform === "darwin" || process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

function assertUniqueAgentDir(params: {
  cfg: OpenClawConfig;
  agentId: string;
  candidateAgentDir: string;
}) {
  const duplicates = findDuplicateAgentDirs(params.cfg);
  if (duplicates.length > 0) {
    throw new DuplicateAgentDirError(duplicates);
  }

  const candidateKey = canonicalizePath(params.candidateAgentDir);
  const ids = listAgentIds(params.cfg);
  for (const existingId of ids) {
    if (existingId === params.agentId) {
      continue;
    }
    const existingAgentDir = resolveAgentDir(params.cfg, existingId);
    if (canonicalizePath(existingAgentDir) === candidateKey) {
      throw new Error(
        `agentDir collision: "${params.agentId}" and "${existingId}" both resolve to ${params.candidateAgentDir}`,
      );
    }
  }
}

export function listAgentInitTemplates(): AgentInitTemplateName[] {
  return [...TEMPLATE_NAMES];
}

export function initAgentWorkspace(params: {
  cfg: OpenClawConfig;
  agentId: string;
  template: string;
  workspaceDir?: string;
  force?: boolean;
}): InitAgentWorkspaceResult {
  const template = normalizeTemplateName(params.template);
  if (!template) {
    throw new Error(
      `unsupported template "${params.template}". Expected one of: ${TEMPLATE_NAMES.join(", ")}`,
    );
  }
  const agentId = normalizeAgentId(params.agentId);
  const force = Boolean(params.force);

  const candidateAgentDir = resolveAgentDir(params.cfg, agentId);
  assertUniqueAgentDir({
    cfg: params.cfg,
    agentId,
    candidateAgentDir,
  });

  const explicitWorkspace = params.workspaceDir?.trim()
    ? resolveUserPath(params.workspaceDir.trim())
    : undefined;
  const workspaceDir = explicitWorkspace ?? resolveMultiAgentAgentWorkspace(agentId, params.cfg);

  const shared = ensureMultiAgentSharedLayout(params.cfg);
  const workspacesRoot = resolveMultiAgentWorkspacesRoot(params.cfg);

  const templateDir = resolveTemplateDir(template);
  const soulTemplatePath = path.join(templateDir, "SOUL.md");
  const policyTemplatePath = path.join(templateDir, "policy.json");
  const soulContent = fs.readFileSync(soulTemplatePath, "utf-8");
  const policyContent = fs.readFileSync(policyTemplatePath, "utf-8");

  const created: string[] = [];
  const skipped: string[] = [];
  const forced: string[] = [];

  ensureDirWithMode({
    dirPath: workspaceDir,
    force,
    created,
    skipped,
    forced,
  });

  for (const dirName of ["skills", "memory", "tasks", "notes"]) {
    ensureDirWithMode({
      dirPath: path.join(workspaceDir, dirName),
      force,
      created,
      skipped,
      forced,
    });
  }

  writeFileWithMode({
    filePath: path.join(workspaceDir, "SOUL.md"),
    content: soulContent,
    force,
    created,
    skipped,
    forced,
  });
  writeFileWithMode({
    filePath: path.join(workspaceDir, "policy.json"),
    content: policyContent,
    force,
    created,
    skipped,
    forced,
  });

  return {
    agentId,
    template,
    workspaceDir,
    workspacesRoot,
    sharedRoot: shared.sharedRoot,
    created,
    skipped,
    forced,
  };
}
