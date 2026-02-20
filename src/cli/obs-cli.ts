import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import {
  emitObservabilityTestEvent,
  flushObservability,
  getObservabilityPaths,
} from "../infra/observability.js";
import { defaultRuntime } from "../runtime.js";

function formatUtcDay(timestamp: number): string {
  const date = new Date(timestamp);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function resolveAuditFile(dir: string, todayOnly: boolean): Promise<string | null> {
  if (todayOnly) {
    const file = path.join(dir, `${formatUtcDay(Date.now())}.jsonl`);
    try {
      await fs.access(file);
      return file;
    } catch {
      return null;
    }
  }

  try {
    const entries = (await fs.readdir(dir)).filter((entry) => entry.endsWith(".jsonl")).toSorted();
    const latest = entries.at(-1);
    return latest ? path.join(dir, latest) : null;
  } catch {
    return null;
  }
}

function prettyPrintJsonl(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }
  return lines
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;
      return JSON.stringify(parsed, null, 2);
    })
    .join("\n\n");
}

export function registerObsCli(program: Command) {
  const obs = program.command("obs").description("Observability tools");

  obs
    .command("tail")
    .description("Print audit JSONL entries")
    .option("--today", "Read only today's audit file", false)
    .option("--pretty", "Pretty-print JSON entries", false)
    .action(async (opts: { today?: boolean; pretty?: boolean }) => {
      const cfg = loadConfig();
      const { auditDir } = getObservabilityPaths(cfg);
      const file = await resolveAuditFile(auditDir, Boolean(opts.today));
      if (!file) {
        defaultRuntime.error(`No audit log found in ${auditDir}`);
        defaultRuntime.exit(1);
        return;
      }
      const raw = await fs.readFile(file, "utf8");
      defaultRuntime.log(opts.pretty ? prettyPrintJsonl(raw) : raw.trim());
    });

  obs
    .command("verify")
    .description("Verify audit sink writability and event persistence")
    .action(async () => {
      const cfg = loadConfig();
      const { auditDir } = getObservabilityPaths(cfg);
      await fs.mkdir(auditDir, { recursive: true });
      await fs.access(auditDir, fs.constants.W_OK);
      const testId = await emitObservabilityTestEvent(cfg);
      await flushObservability(cfg);
      const file = await resolveAuditFile(auditDir, true);
      if (!file) {
        throw new Error(`audit verify failed: file missing in ${auditDir}`);
      }
      const raw = await fs.readFile(file, "utf8");
      if (!raw.includes(testId)) {
        throw new Error(`audit verify failed: event ${testId} not found in ${file}`);
      }
      defaultRuntime.log(`ok ${testId} ${file}`);
    });
}
