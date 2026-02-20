export type CircuitBreakerStatus = "closed" | "half_open" | "open";

export type HealthKey = {
  provider: string;
  modelRef: string;
};

export type HealthState = {
  provider: string;
  modelRef: string;
  status: CircuitBreakerStatus;
  failures: number[];
  openUntil?: number;
  updatedAt: number;
};

export type HealthStateChangeEvent = {
  provider: string;
  modelRef: string;
  previous: CircuitBreakerStatus;
  next: CircuitBreakerStatus;
  timestamp: number;
  reason: string;
};

export type HealthTrackerOptions = {
  failureThreshold?: number;
  windowMs?: number;
  openMs?: number;
};
