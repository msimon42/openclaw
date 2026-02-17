import { randomUUID } from "node:crypto";

export function newUuid(): string {
  return randomUUID();
}
