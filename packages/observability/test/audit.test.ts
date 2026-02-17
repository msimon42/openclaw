import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";
import { JsonlAuditSink } from "../src/audit/sinks/jsonl-sink.js";
import { MemoryAuditSink } from "../src/audit/sinks/memory-sink.js";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("audit logger", () => {
  it("redacts secrets even in debug mode", async () => {
    const sink = new MemoryAuditSink();
    const logger = new AuditLogger({
      sink,
      redaction: { mode: "debug", maxDebugStringChars: 128 },
    });

    await logger.emitAsync({
      traceId: "trace-1",
      agentId: "agent-1",
      eventType: "tool.call.start",
      payload: {
        apiKey: "should-not-appear",
        nested: {
          token: "also-hidden",
          authorization: "Bearer secret",
        },
        prompt: "hello",
      },
    });
    await logger.flush();

    const stored = sink.getEvents()[0];
    expect(stored).toBeTruthy();
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("should-not-appear");
    expect(serialized).not.toContain("also-hidden");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("writes parseable JSONL", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-observability-audit-"));
    createdDirs.push(tmpDir);

    const sink = new JsonlAuditSink({ dir: tmpDir });
    const logger = new AuditLogger({ sink });

    await logger.emitAsync({
      traceId: "trace-jsonl",
      agentId: "agent-1",
      eventType: "request.start",
      payload: { hello: "world" },
    });
    await logger.flush();

    const files = await fs.readdir(tmpDir);
    expect(files.length).toBe(1);
    const raw = await fs.readFile(path.join(tmpDir, files[0] ?? ""), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.eventType).toBe("request.start");
  });
});
