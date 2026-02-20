import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { getObservabilityPaths } from "../infra/observability.js";
import { defaultRuntime } from "../runtime.js";

type SpendRecord = {
  timestamp: number;
  agentId: string;
  modelRef: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  traceId: string;
};

function isToday(timestamp: number): boolean {
  const target = new Date(timestamp);
  const now = new Date();
  return (
    target.getUTCFullYear() === now.getUTCFullYear() &&
    target.getUTCMonth() === now.getUTCMonth() &&
    target.getUTCDate() === now.getUTCDate()
  );
}

async function readSpendRecords(spendDir: string): Promise<SpendRecord[]> {
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(spendDir)).filter((entry) => entry.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const records: SpendRecord[] = [];
  for (const entry of entries) {
    const file = path.join(spendDir, entry);
    const raw = await fs.readFile(file, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        records.push(JSON.parse(trimmed) as SpendRecord);
      } catch {
        // skip malformed lines
      }
    }
  }
  return records;
}

export function registerSpendCli(program: Command) {
  const spend = program.command("spend").description("Spend tracking reports");

  spend
    .command("report")
    .description("Report model spend totals")
    .option("--today", "Limit to current UTC day", false)
    .option("--agent <id>", "Filter by agent id")
    .action(async (opts: { today?: boolean; agent?: string }) => {
      const cfg = loadConfig();
      const { spendDir } = getObservabilityPaths(cfg);
      const all = await readSpendRecords(spendDir);
      const filtered = all.filter((record) => {
        if (opts.today && !isToday(record.timestamp)) {
          return false;
        }
        if (opts.agent && record.agentId !== opts.agent) {
          return false;
        }
        return true;
      });

      const summary = {
        records: filtered.length,
        tokensIn: filtered.reduce((sum, row) => sum + (row.tokensIn ?? 0), 0),
        tokensOut: filtered.reduce((sum, row) => sum + (row.tokensOut ?? 0), 0),
        costUsd: Number(filtered.reduce((sum, row) => sum + (row.costUsd ?? 0), 0).toFixed(8)),
      };
      defaultRuntime.log(JSON.stringify(summary, null, 2));
    });
}
