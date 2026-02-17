import { Command } from "commander";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, getObservabilityPathsMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  getObservabilityPathsMock: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../infra/observability.js", () => ({
  getObservabilityPaths: getObservabilityPathsMock,
}));

const createdDirs: string[] = [];

function nowRecord(
  overrides?: Partial<{ agentId: string; tokensIn: number; tokensOut: number; costUsd: number }>,
) {
  return {
    timestamp: Date.now(),
    agentId: overrides?.agentId ?? "main",
    modelRef: "openai/gpt-5.3-codex",
    tokensIn: overrides?.tokensIn ?? 10,
    tokensOut: overrides?.tokensOut ?? 5,
    costUsd: overrides?.costUsd ?? 0.123,
    traceId: "trace-1",
  };
}

describe("spend cli", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    getObservabilityPathsMock.mockReset();
  });

  afterEach(async () => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("reports spend totals", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-spend-cli-"));
    createdDirs.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, "2026-02.jsonl"),
      [
        JSON.stringify(nowRecord()),
        JSON.stringify(nowRecord({ tokensIn: 20, tokensOut: 10 })),
      ].join("\n") + "\n",
      "utf8",
    );

    loadConfigMock.mockReturnValue({});
    getObservabilityPathsMock.mockReturnValue({ auditDir: tmpDir, spendDir: tmpDir });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    const { registerSpendCli } = await import("./spend-cli.js");
    const program = new Command();
    program.exitOverride();
    registerSpendCli(program);

    await program.parseAsync(["spend", "report", "--today", "--agent", "main"], {
      from: "user",
    });

    logSpy.mockRestore();
    const output = logs.join("\n");
    expect(output).toContain('"records": 2');
    expect(output).toContain('"tokensIn": 30');
    expect(output).toContain('"tokensOut": 15');
  });
});
