import { createHash } from "node:crypto";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  const output: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    output[key] = sortValue(nested);
  }
  return output;
}

export function stableHash(value: unknown): string {
  const normalized = typeof value === "string" ? value : JSON.stringify(sortValue(value));
  return createHash("sha256")
    .update(normalized ?? "", "utf8")
    .digest("hex");
}
