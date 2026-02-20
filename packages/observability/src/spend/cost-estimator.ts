export type ModelPricing = {
  inputPer1kUsd?: number;
  outputPer1kUsd?: number;
};

export type PricingTable = Record<string, ModelPricing>;

function toCost(tokens: number | undefined, per1k: number | undefined): number {
  if (!tokens || !per1k || tokens <= 0 || per1k <= 0) {
    return 0;
  }
  return (tokens / 1000) * per1k;
}

function resolvePricing(modelRef: string, pricingTable?: PricingTable): ModelPricing | undefined {
  if (!pricingTable) {
    return undefined;
  }
  const direct = pricingTable[modelRef];
  if (direct) {
    return direct;
  }
  const provider = modelRef.split("/")[0] ?? "";
  if (!provider) {
    return undefined;
  }
  return pricingTable[`${provider}/*`] ?? pricingTable[provider];
}

export function estimateCostUsd(input: {
  modelRef: string;
  tokensIn?: number;
  tokensOut?: number;
  pricingTable?: PricingTable;
}): number | undefined {
  const pricing = resolvePricing(input.modelRef, input.pricingTable);
  if (!pricing) {
    return undefined;
  }
  const cost =
    toCost(input.tokensIn, pricing.inputPer1kUsd) + toCost(input.tokensOut, pricing.outputPer1kUsd);
  return cost > 0 ? Number(cost.toFixed(8)) : 0;
}
