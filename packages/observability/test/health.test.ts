import { describe, expect, it } from "vitest";
import { HealthTracker } from "../src/health/health-tracker.js";

describe("health tracker", () => {
  it("opens circuit after threshold and emits state changes", () => {
    const tracker = new HealthTracker({ failureThreshold: 2, windowMs: 60_000, openMs: 60_000 });
    const events: Array<{ previous: string; next: string; reason: string }> = [];

    tracker.onStateChange((event) => {
      events.push({ previous: event.previous, next: event.next, reason: event.reason });
    });

    tracker.noteFailure("openai", "openai/gpt-5.3-codex", "timeout");
    tracker.noteFailure("openai", "openai/gpt-5.3-codex", "timeout");

    const state = tracker.getState("openai", "openai/gpt-5.3-codex");
    expect(state?.status).toBe("open");
    expect(events.some((event) => event.next === "open")).toBe(true);
  });
});
