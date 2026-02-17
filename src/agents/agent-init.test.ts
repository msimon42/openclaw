import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { initAgentWorkspace } from "./agent-init.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeConfig(workspaceRoot: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        multiAgent: {
          workspaceRoot,
        },
      },
      list: [{ id: "main" }],
    },
  };
}

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("initAgentWorkspace", () => {
  it("is idempotent without --force", () => {
    const root = mkTempDir("openclaw-init-");
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
    const cfg = makeConfig(path.join(root, "workspaces"));

    const first = initAgentWorkspace({
      cfg,
      agentId: "worker",
      template: "worker",
    });
    expect(first.created.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(first.workspaceDir, "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(first.workspaceDir, "policy.json"))).toBe(true);

    const second = initAgentWorkspace({
      cfg,
      agentId: "worker",
      template: "worker",
    });
    expect(second.created.length).toBe(0);
    expect(second.skipped.length).toBeGreaterThan(0);
    expect(second.forced.length).toBe(0);
  });

  it("creates expected template files", () => {
    const root = mkTempDir("openclaw-init-template-");
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
    const cfg = makeConfig(path.join(root, "workspaces"));

    const result = initAgentWorkspace({
      cfg,
      agentId: "admin",
      template: "admin",
    });
    const soul = fs.readFileSync(path.join(result.workspaceDir, "SOUL.md"), "utf-8");
    const policy = JSON.parse(fs.readFileSync(path.join(result.workspaceDir, "policy.json"), "utf-8")) as {
      role?: string;
    };

    expect(soul).toContain("Admin Agent");
    expect(policy.role).toBe("admin");
  });

  it("enforces unique agentDir across agents", () => {
    const root = mkTempDir("openclaw-init-agentdir-");
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
    const stateRoot = path.join(root, "state");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          multiAgent: {
            workspaceRoot: path.join(root, "workspaces"),
          },
        },
        list: [
          {
            id: "main",
            agentDir: path.join(stateRoot, "agents", "worker", "agent"),
          },
        ],
      },
    };

    expect(() =>
      initAgentWorkspace({
        cfg,
        agentId: "worker",
        template: "worker",
      }),
    ).toThrow(/agentDir collision/i);
  });
});
