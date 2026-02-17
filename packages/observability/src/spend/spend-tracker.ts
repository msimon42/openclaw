import fs from "node:fs";
import path from "node:path";
import type { SpendRecord, SpendSummary } from "./spend-types.js";
import { nowMs } from "../util/now.js";
import { estimateCostUsd, type PricingTable } from "./cost-estimator.js";

type SpendTrackerOptions = {
  enabled?: boolean;
  dir: string;
  summaryPath?: string;
  pricingTable?: PricingTable;
};

function monthKey(timestamp: number): string {
  const date = new Date(timestamp);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function initialSummary(): SpendSummary {
  return {
    updatedAt: nowMs(),
    totals: {
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    },
    byModel: [],
    byAgent: [],
  };
}

export class SpendTracker {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly summaryPath: string;
  private readonly pricingTable?: PricingTable;
  private readonly queue: SpendRecord[] = [];
  private summary: SpendSummary = initialSummary();
  private summaryLoaded = false;

  constructor(options: SpendTrackerOptions) {
    this.enabled = options.enabled ?? true;
    this.dir = options.dir;
    this.summaryPath = options.summaryPath ?? path.join(options.dir, "summary.json");
    this.pricingTable = options.pricingTable;
  }

  private async ensureSummaryLoaded() {
    if (this.summaryLoaded) {
      return;
    }
    this.summaryLoaded = true;
    try {
      const raw = await fs.promises.readFile(this.summaryPath, "utf8");
      const parsed = JSON.parse(raw) as SpendSummary;
      if (
        parsed &&
        parsed.totals &&
        Array.isArray(parsed.byModel) &&
        Array.isArray(parsed.byAgent)
      ) {
        this.summary = parsed;
      }
    } catch {
      // no-op
    }
  }

  recordCall(input: Omit<SpendRecord, "costUsd"> & { costUsd?: number }): SpendRecord {
    const record: SpendRecord = {
      ...input,
      costUsd:
        input.costUsd ??
        estimateCostUsd({
          modelRef: input.modelRef,
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
          pricingTable: this.pricingTable,
        }),
    };
    if (this.enabled) {
      this.queue.push(record);
    }
    return record;
  }

  private applyToSummary(record: SpendRecord) {
    this.summary.updatedAt = nowMs();
    this.summary.totals.calls += 1;
    this.summary.totals.tokensIn += record.tokensIn ?? 0;
    this.summary.totals.tokensOut += record.tokensOut ?? 0;
    this.summary.totals.costUsd = Number(
      (this.summary.totals.costUsd + (record.costUsd ?? 0)).toFixed(8),
    );

    const modelEntry =
      this.summary.byModel.find((entry) => entry.modelRef === record.modelRef) ??
      (() => {
        const created = {
          modelRef: record.modelRef,
          calls: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        };
        this.summary.byModel.push(created);
        return created;
      })();
    modelEntry.calls += 1;
    modelEntry.tokensIn += record.tokensIn ?? 0;
    modelEntry.tokensOut += record.tokensOut ?? 0;
    modelEntry.costUsd = Number((modelEntry.costUsd + (record.costUsd ?? 0)).toFixed(8));

    const agentEntry =
      this.summary.byAgent.find((entry) => entry.agentId === record.agentId) ??
      (() => {
        const created = {
          agentId: record.agentId,
          calls: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        };
        this.summary.byAgent.push(created);
        return created;
      })();
    agentEntry.calls += 1;
    agentEntry.tokensIn += record.tokensIn ?? 0;
    agentEntry.tokensOut += record.tokensOut ?? 0;
    agentEntry.costUsd = Number((agentEntry.costUsd + (record.costUsd ?? 0)).toFixed(8));
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0) {
      return;
    }

    await this.ensureSummaryLoaded();
    await fs.promises.mkdir(this.dir, { recursive: true });

    const grouped = new Map<string, SpendRecord[]>();
    for (const record of this.queue.splice(0, this.queue.length)) {
      const key = monthKey(record.timestamp);
      const list = grouped.get(key) ?? [];
      list.push(record);
      grouped.set(key, list);
      this.applyToSummary(record);
    }

    for (const [key, records] of grouped) {
      const filePath = path.join(this.dir, `${key}.jsonl`);
      const lines = records.map((record) => JSON.stringify(record)).join("\n");
      await fs.promises.appendFile(filePath, `${lines}\n`, "utf8");
    }

    await fs.promises.writeFile(this.summaryPath, JSON.stringify(this.summary, null, 2), "utf8");
  }

  getSummary(): SpendSummary {
    return structuredClone(this.summary);
  }
}
