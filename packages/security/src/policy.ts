import type { Capability, EffectivePolicy, PolicyLayer } from "./types.js";

const normalizeList = (value?: string[]): string[] =>
  Array.isArray(value)
    ? value
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase())
    : [];

export function resolvePolicy(layers: PolicyLayer[]): EffectivePolicy {
  const allow = new Set<Capability>();
  const deny = new Set<Capability>();

  let allowDomains: string[] = [];
  let writePaths: string[] = [];
  let requireApproval = false;

  for (const layer of layers) {
    for (const capability of layer.allow ?? []) {
      allow.add(capability);
    }
    for (const capability of layer.deny ?? []) {
      deny.add(capability);
    }

    const nextDomains = normalizeList(layer.allowDomains);
    if (nextDomains.length > 0) {
      allowDomains =
        allowDomains.length === 0
          ? nextDomains
          : allowDomains.filter((domain) => nextDomains.includes(domain));
    }

    const nextPaths = normalizeList(layer.writePaths);
    if (nextPaths.length > 0) {
      writePaths =
        writePaths.length === 0 ? nextPaths : writePaths.filter((dir) => nextPaths.includes(dir));
    }

    if (layer.requireApproval) {
      requireApproval = true;
    }
  }

  for (const capability of deny) {
    allow.delete(capability);
  }

  return {
    allow,
    deny,
    allowDomains,
    writePaths,
    requireApproval,
  };
}
