import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import {
  scanDirectoryWithSummary,
  type SkillScanFinding,
  type SkillScanSummary,
} from "../../security/skill-scanner.js";
import { resolveSkillKey } from "./frontmatter.js";
import { SKILL_MANIFEST_FILENAME } from "./security.js";
import { loadWorkspaceSkillEntries } from "./workspace.js";

export type SkillAuditEntry = {
  skillName: string;
  skillKey: string;
  source: string;
  baseDir: string;
  filePath: string;
  manifestPath?: string;
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  findings: SkillScanFinding[];
};

export type SkillAuditReport = {
  timestamp: string;
  workspaceDir: string;
  totalSkills: number;
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  skills: SkillAuditEntry[];
};

function toEntrySummary(params: {
  entry: ReturnType<typeof loadWorkspaceSkillEntries>[number];
  summary: SkillScanSummary;
}): SkillAuditEntry {
  const skillKey = resolveSkillKey(params.entry.skill, params.entry);
  return {
    skillName: params.entry.skill.name,
    skillKey,
    source: params.entry.skill.source,
    baseDir: params.entry.skill.baseDir,
    filePath: params.entry.skill.filePath,
    ...(params.entry.manifest
      ? { manifestPath: path.join(params.entry.skill.baseDir, SKILL_MANIFEST_FILENAME) }
      : {}),
    scannedFiles: params.summary.scannedFiles,
    critical: params.summary.critical,
    warn: params.summary.warn,
    info: params.summary.info,
    findings: params.summary.findings,
  };
}

export async function auditWorkspaceSkills(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
}): Promise<SkillAuditReport> {
  const entries = loadWorkspaceSkillEntries(params.workspaceDir, {
    config: params.config,
    agentId: params.agentId,
  });
  const uniqueByBaseDir = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (!uniqueByBaseDir.has(entry.skill.baseDir)) {
      uniqueByBaseDir.set(entry.skill.baseDir, entry);
    }
  }

  const skills: SkillAuditEntry[] = [];
  for (const entry of uniqueByBaseDir.values()) {
    const summary = await scanDirectoryWithSummary(entry.skill.baseDir);
    skills.push(
      toEntrySummary({
        entry,
        summary,
      }),
    );
  }

  return {
    timestamp: new Date().toISOString(),
    workspaceDir: params.workspaceDir,
    totalSkills: skills.length,
    scannedFiles: skills.reduce((sum, entry) => sum + entry.scannedFiles, 0),
    critical: skills.reduce((sum, entry) => sum + entry.critical, 0),
    warn: skills.reduce((sum, entry) => sum + entry.warn, 0),
    info: skills.reduce((sum, entry) => sum + entry.info, 0),
    skills,
  };
}
