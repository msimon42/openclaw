import type { CircuitBreakerStatus, HealthState } from "./health-types.js";

export function isCircuitOpen(state: HealthState, now: number): boolean {
  return state.status === "open" && typeof state.openUntil === "number" && state.openUntil > now;
}

export function pruneFailures(state: HealthState, now: number, windowMs: number): void {
  state.failures = state.failures.filter((timestamp) => now - timestamp <= windowMs);
}

export function nextStatus(
  current: CircuitBreakerStatus,
  next: CircuitBreakerStatus,
): CircuitBreakerStatus {
  if (current === next) {
    return current;
  }
  return next;
}
