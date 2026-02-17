import { Command } from "commander";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, getObservabilityPathsMock, emitObservabilityTestEventMock, flushMock } =
  vi.hoisted(() => ({
    loadConfigMock: vi.fn(),
    getObservabilityPathsMock: vi.fn(),
    emitObservabilityTestEventMock: vi.fn(),
    flushMock: vi.fn(),
  }));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../infra/observability.js", () => ({
  getObservabilityPaths: getObservabilityPathsMock,
  emitObservabilityTestEvent: emitObservabilityTestEventMock,
  flushObservability: flushMock,
}));

const createdDirs: string[] = [];

function utcDay(): string {
  const date = new Date();
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

describe("obs cli", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    getObservabilityPathsMock.mockReset();
    emitObservabilityTestEventMock.mockReset();
    flushMock.mockReset();
  });

  afterEach(async () => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("tails today's audit log with pretty output", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obs-cli-"));
    createdDirs.push(tmpDir);
    const auditFile = path.join(tmpDir, `${utcDay()}.jsonl`);
    await fs.writeFile(
      auditFile,
      `${JSON.stringify({ eventType: "request.start", payload: { ok: true } })}\n`,
      "utf8",
    );

    loadConfigMock.mockReturnValue({});
    getObservabilityPathsMock.mockReturnValue({ auditDir: tmpDir, spendDir: tmpDir });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    const { registerObsCli } = await import("./obs-cli.js");
    const program = new Command();
    program.exitOverride();
    registerObsCli(program);

    await program.parseAsync(["obs", "tail", "--today", "--pretty"], { from: "user" });

    logSpy.mockRestore();
    expect(logs.join("\n")).toContain("request.start");
  });

  it("verifies audit logging", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obs-verify-"));
    createdDirs.push(tmpDir);
    const testId = "obs-test-unit";
    const auditFile = path.join(tmpDir, `${utcDay()}.jsonl`);

    loadConfigMock.mockReturnValue({});
    getObservabilityPathsMock.mockReturnValue({ auditDir: tmpDir, spendDir: tmpDir });
    emitObservabilityTestEventMock.mockImplementation(async () => {
      await fs.writeFile(
        auditFile,
        `${JSON.stringify({ eventType: "observability.verify", payload: { testId } })}\n`,
        "utf8",
      );
      return testId;
    });
    flushMock.mockResolvedValue(undefined);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    const { registerObsCli } = await import("./obs-cli.js");
    const program = new Command();
    program.exitOverride();
    registerObsCli(program);

    await program.parseAsync(["obs", "verify"], { from: "user" });

    logSpy.mockRestore();
    expect(logs.join("\n")).toContain(`ok ${testId}`);
  });
});
