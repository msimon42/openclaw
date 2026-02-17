import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpendTracker } from "../src/spend/spend-tracker.js";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("spend tracker", () => {
  it("records spend and writes summary", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-observability-spend-"));
    createdDirs.push(tmpDir);

    const tracker = new SpendTracker({
      dir: tmpDir,
      pricingTable: {
        "openai/gpt-5.3-codex": { inputPer1kUsd: 0.01, outputPer1kUsd: 0.03 },
      },
    });

    tracker.recordCall({
      timestamp: Date.now(),
      agentId: "main",
      modelRef: "openai/gpt-5.3-codex",
      tokensIn: 2000,
      tokensOut: 1000,
      traceId: "trace-1",
    });

    await tracker.flush();

    const summaryPath = path.join(tmpDir, "summary.json");
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8")) as {
      totals: { calls: number; tokensIn: number; tokensOut: number; costUsd: number };
    };
    expect(summary.totals.calls).toBe(1);
    expect(summary.totals.tokensIn).toBe(2000);
    expect(summary.totals.tokensOut).toBe(1000);
    expect(summary.totals.costUsd).toBeGreaterThan(0);
  });
});
