import type { HealthState, HealthStateChangeEvent, HealthTrackerOptions } from "./health-types.js";
import { nowMs } from "../util/now.js";
import { isCircuitOpen, nextStatus, pruneFailures } from "./circuit-breaker-state.js";

function key(provider: string, modelRef: string): string {
  return `${provider}/${modelRef}`;
}

export class HealthTracker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly states = new Map<string, HealthState>();
  private readonly listeners = new Set<(event: HealthStateChangeEvent) => void>();

  constructor(options?: HealthTrackerOptions) {
    this.failureThreshold = Math.max(1, options?.failureThreshold ?? 3);
    this.windowMs = Math.max(1_000, options?.windowMs ?? 60_000);
    this.openMs = Math.max(1_000, options?.openMs ?? 60_000);
  }

  private emitChange(event: HealthStateChangeEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private ensureState(provider: string, modelRef: string, now: number): HealthState {
    const id = key(provider, modelRef);
    const existing = this.states.get(id);
    if (existing) {
      if (existing.status === "open" && existing.openUntil && existing.openUntil <= now) {
        const previous = existing.status;
        existing.status = nextStatus(existing.status, "half_open");
        existing.openUntil = undefined;
        existing.updatedAt = now;
        this.emitChange({
          provider,
          modelRef,
          previous,
          next: existing.status,
          timestamp: now,
          reason: "open_timeout_elapsed",
        });
      }
      pruneFailures(existing, now, this.windowMs);
      return existing;
    }
    const created: HealthState = {
      provider,
      modelRef,
      status: "closed",
      failures: [],
      updatedAt: now,
    };
    this.states.set(id, created);
    return created;
  }

  canAttempt(provider: string, modelRef: string): boolean {
    const now = nowMs();
    const state = this.ensureState(provider, modelRef, now);
    return !isCircuitOpen(state, now);
  }

  noteSuccess(provider: string, modelRef: string): HealthState {
    const now = nowMs();
    const state = this.ensureState(provider, modelRef, now);
    const previous = state.status;
    state.failures = [];
    state.status = "closed";
    state.openUntil = undefined;
    state.updatedAt = now;
    if (previous !== state.status) {
      this.emitChange({
        provider,
        modelRef,
        previous,
        next: state.status,
        timestamp: now,
        reason: "success",
      });
    }
    return state;
  }

  noteFailure(provider: string, modelRef: string, reason = "failure"): HealthState {
    const now = nowMs();
    const state = this.ensureState(provider, modelRef, now);
    const previous = state.status;
    state.failures.push(now);
    pruneFailures(state, now, this.windowMs);
    if (state.failures.length >= this.failureThreshold) {
      state.status = "open";
      state.openUntil = now + this.openMs;
    }
    state.updatedAt = now;
    if (previous !== state.status) {
      this.emitChange({
        provider,
        modelRef,
        previous,
        next: state.status,
        timestamp: now,
        reason,
      });
    }
    return state;
  }

  getState(provider: string, modelRef: string): HealthState | undefined {
    const state = this.states.get(key(provider, modelRef));
    return state ? structuredClone(state) : undefined;
  }

  onStateChange(listener: (event: HealthStateChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
