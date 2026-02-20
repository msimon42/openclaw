import { describe, expect, it } from "vitest";
import { renderObservability } from "./observability.ts";

function createProps() {
  return {
    connected: true,
    status: {
      available: true,
      subscribed: true,
      lastError: null,
      lastSeenTs: Date.now(),
    },
    section: "audit" as const,
    onSectionChange: () => {},
    filter: {},
    onFilterChange: () => {},
    availableAgents: [],
    availableEventTypes: [],
    availableModelRefs: [],
    availableRiskTiers: [],
    events: [],
    selectedEventId: null,
    onSelectEvent: () => {},
    traceEvents: [],
    spendWindow: "15m" as const,
    onSpendWindowChange: () => {},
    derivedSpend: {
      totals: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      byModel: [],
      byAgent: [],
    },
    fallbackCounts: [],
    healthSummary: null,
  };
}

function isTemplateLike(
  value: unknown,
): value is { strings: ArrayLike<string>; values?: unknown[] } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "strings" in value &&
    Array.isArray((value as { strings?: unknown }).strings),
  );
}

function collectTemplateText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTemplateText(entry, out);
    }
    return out;
  }
  if (isTemplateLike(value)) {
    out.push(...Array.from(value.strings));
    for (const child of value.values ?? []) {
      collectTemplateText(child, out);
    }
  }
  return out;
}

describe("observability view", () => {
  it("includes disabled state text when stream is unavailable", () => {
    const tpl = renderObservability({
      ...createProps(),
      status: {
        available: false,
        subscribed: false,
        lastError: null,
        lastSeenTs: 0,
      },
    });
    const staticText = collectTemplateText(tpl).join(" ");
    expect(staticText).toContain("Observability stream is disabled");
  });

  it("includes audit section controls", () => {
    const tpl = renderObservability(createProps());
    const staticText = collectTemplateText(tpl).join(" ");
    expect(staticText).toContain("Live Audit");
    expect(staticText).toContain("Event Details");
  });
});
