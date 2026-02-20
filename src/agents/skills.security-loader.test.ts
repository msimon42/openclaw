import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => {
  const loadSkillsFromDir = ({ dir, source }: { dir: string; source: string }) => {
    try {
      const dirents = fs.readdirSync(dir, { withFileTypes: true });
      return dirents
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const baseDir = path.join(dir, entry.name);
          const filePath = path.join(baseDir, "SKILL.md");
          return { name: entry.name, description: entry.name, filePath, baseDir, source };
        })
        .filter((entry) => fs.existsSync(entry.filePath));
    } catch {
      return [];
    }
  };

  return {
    formatSkillsForPrompt: () => "",
    loadSkillsFromDir,
  };
});

const { loadWorkspaceSkillEntries } = await import("./skills/workspace.js");

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-security-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

async function writeSkill(params: {
  skillDir: string;
  name: string;
  description: string;
  manifestCapabilities?: string[];
  withManifest?: boolean;
  manifestRaw?: string;
  manifestPolicy?: Record<string, unknown>;
}) {
  await fsp.mkdir(params.skillDir, { recursive: true });
  await fsp.writeFile(
    path.join(params.skillDir, "SKILL.md"),
    `---\nname: ${params.name}\ndescription: ${params.description}\n---\n\n# ${params.name}\n`,
    "utf-8",
  );
  if (params.withManifest === false) {
    return;
  }
  if (typeof params.manifestRaw === "string") {
    await fsp.writeFile(
      path.join(params.skillDir, "skill.manifest.json"),
      params.manifestRaw,
      "utf-8",
    );
    return;
  }
  await fsp.writeFile(
    path.join(params.skillDir, "skill.manifest.json"),
    JSON.stringify(
      {
        id: params.name,
        name: params.name,
        version: "1.0.0",
        entry: "SKILL.md",
        capabilities: params.manifestCapabilities ?? ["model.invoke"],
        ...(params.manifestPolicy ? { policy: params.manifestPolicy } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  );
});

describe("skills security loader", () => {
  it("rejects untrusted skills that do not include a manifest", async () => {
    const workspaceDir = await makeWorkspace();
    const extraDir = path.join(workspaceDir, ".extra");
    await writeSkill({
      skillDir: path.join(extraDir, "no-manifest"),
      name: "no-manifest",
      description: "Should be rejected",
      withManifest: false,
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [extraDir] },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.find((entry) => entry.skill.name === "no-manifest")).toBeUndefined();
  });

  it("blocks a skill when declared capabilities exceed effective policy", async () => {
    const workspaceDir = await makeWorkspace();
    const extraDir = path.join(workspaceDir, ".extra");
    await writeSkill({
      skillDir: path.join(extraDir, "shell-skill"),
      name: "shell-skill",
      description: "Requests shell",
      manifestCapabilities: ["shell.exec"],
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [extraDir] },
          policy: { allow: ["filesystem.read"] },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.find((entry) => entry.skill.name === "shell-skill")).toBeUndefined();
  });

  it("rejects a skill when manifest JSON is malformed", async () => {
    const workspaceDir = await makeWorkspace();
    const extraDir = path.join(workspaceDir, ".extra");
    await writeSkill({
      skillDir: path.join(extraDir, "bad-manifest-json"),
      name: "bad-manifest-json",
      description: "Invalid JSON manifest should be rejected",
      manifestRaw: "{ invalid-json",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [extraDir] },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.find((entry) => entry.skill.name === "bad-manifest-json")).toBeUndefined();
  });

  it("rejects a skill when manifest policy denies a declared capability", async () => {
    const workspaceDir = await makeWorkspace();
    const extraDir = path.join(workspaceDir, ".extra");
    await writeSkill({
      skillDir: path.join(extraDir, "manifest-deny-shell"),
      name: "manifest-deny-shell",
      description: "Manifest policy should block declared shell capability",
      manifestCapabilities: ["shell.exec"],
      manifestPolicy: { deny: ["shell.exec"] },
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [extraDir] },
          policy: { allow: ["shell.exec"] },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.find((entry) => entry.skill.name === "manifest-deny-shell")).toBeUndefined();
  });

  it("applies policy order and allows agent policy to override global policy", async () => {
    const workspaceDir = await makeWorkspace();
    const extraDir = path.join(workspaceDir, ".extra");
    await writeSkill({
      skillDir: path.join(extraDir, "agent-shell"),
      name: "agent-shell",
      description: "Agent-level override should allow this",
      manifestCapabilities: ["shell.exec"],
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [extraDir] },
          policy: { allow: ["filesystem.read"] },
        },
        agents: {
          list: [
            {
              id: "main",
              skillsPolicy: { allow: ["shell.exec"] },
            },
          ],
        },
      },
      agentId: "main",
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.find((entry) => entry.skill.name === "agent-shell")).toBeDefined();
  });
});
