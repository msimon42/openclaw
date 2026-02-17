import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { fetchArtifact, publishArtifact } from "./artifacts.js";

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

function mkTempWorkspaceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-artifacts-"));
  return path.join(root, "workspaces");
}

describe("artifact store", () => {
  it("publishes and fetches text artifacts with provenance metadata", () => {
    const workspaceRoot = mkTempWorkspaceRoot();
    const cfg = makeConfig(workspaceRoot);
    const content = "delegated handoff payload";
    const hash = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
    const expectedArtifactId = `art_${hash}`;

    const published = publishArtifact({
      cfg,
      content,
      createdByAgentId: "main",
      traceId: "trace-artifact-1",
      kind: "text/plain",
    });

    expect(published.artifactId).toBe(expectedArtifactId);
    expect(fs.existsSync(published.payloadPath)).toBe(true);
    expect(fs.existsSync(published.metaPath)).toBe(true);
    expect(published.metadata.createdByAgentId).toBe("main");
    expect(published.metadata.traceId).toBe("trace-artifact-1");
    expect(published.metadata.hash).toBe(hash);
    expect(published.metadata.kind).toBe("text/plain");
    expect(published.metadata.schemaVersion).toBe("1.0");

    const fetched = fetchArtifact({
      cfg,
      artifactId: published.artifactId,
      fetchedByAgentId: "main",
      traceId: "trace-artifact-1",
    });
    expect(fetched.artifactId).toBe(published.artifactId);
    expect(fetched.content).toBe(content);
    expect(fetched.metadata.createdByAgentId).toBe("main");
    expect(fetched.metadata.traceId).toBe("trace-artifact-1");
  });

  it("roundtrips JSON artifact payloads", () => {
    const workspaceRoot = mkTempWorkspaceRoot();
    const cfg = makeConfig(workspaceRoot);
    const content = {
      kind: "brief",
      summary: "Worker completed phase",
      score: 0.97,
    };

    const published = publishArtifact({
      cfg,
      content,
      createdByAgentId: "worker",
      traceId: "trace-artifact-json",
      kind: "application/json",
    });
    const fetched = fetchArtifact({
      cfg,
      artifactId: published.artifactId,
      fetchedByAgentId: "admin",
      traceId: "trace-artifact-json",
    });

    expect(fetched.metadata.createdByAgentId).toBe("worker");
    expect(fetched.metadata.traceId).toBe("trace-artifact-json");
    expect(fetched.metadata.kind).toBe("application/json");
    expect(fetched.content).toEqual(content);
  });
});

