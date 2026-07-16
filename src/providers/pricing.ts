/**
 * Cost & usage math (SPEC §6). Two figures:
 *   - estimate (pre-flight, "≈$"): from pricing metadata + chosen size/quality/n.
 *   - actual: from the usage tokens the provider returns — the statistics
 *     source of truth (cost_source = 'actual').
 *
 * Currency USD, rounded to $0.001.
 */

import type { GenerateRequest, GenerationUsage, ModelDescriptor, Quality } from "./types";

export type CostSource = "estimated" | "actual";

function round3(usd: number): number {
  return Math.round(usd * 1000) / 1000;
}

function sizeKey(width: number, height: number): string {
  return `${width}x${height}`;
}

/** Quality to price at when the request leaves it unset/auto — upper-bound so "≈$" never under-quotes. */
function qualityForEstimate(q: Quality | undefined): Quality {
  return q && q !== "auto" ? q : "high";
}

/**
 * Pre-flight estimate. Returns undefined when the model can't be priced
 * statically for the chosen size (e.g. gpt-image-2 arbitrary resolution → needs
 * the official calculator or the actual returned usage).
 */
export function estimateCostUSD(model: ModelDescriptor, req: GenerateRequest): number | undefined {
  const n = Math.max(1, req.n ?? 1);
  const { pricing } = model;

  if (req.sizeSpec.kind === "pixels") {
    const key = sizeKey(req.sizeSpec.width, req.sizeSpec.height);
    const quality = qualityForEstimate(req.quality);

    const tableUSD = pricing.perImageTable?.[`${key}:${quality}`];
    if (tableUSD !== undefined) return round3(tableUSD * n);

    // Fall back to the token basis for the canonical 1024² sizes.
    const tokens = pricing.outputTokens1024?.[quality];
    if (tokens !== undefined && key === "1024x1024") {
      return round3((tokens * pricing.imageOutputPerMTok) / 1e6 * n);
    }
    return undefined;
  }

  // ratio (Gemini): per-tier table if present, else not statically priceable yet.
  const tierUSD = pricing.perImageTable?.[req.sizeSpec.imageSize];
  return tierUSD !== undefined ? round3(tierUSD * n) : undefined;
}

/**
 * Actual cost from returned usage tokens (SPEC §6 algorithm). This is what gets
 * persisted as cost_usd with cost_source='actual'.
 */
export function actualCostFromUsage(
  model: ModelDescriptor,
  usage: GenerationUsage,
): number | undefined {
  const { pricing } = model;
  const out = usage.imageOutputTokens;
  if (out === undefined) return undefined;

  const textIn = usage.textInputTokens ?? 0;
  const imgIn = usage.imageInputTokens ?? 0;

  const usd =
    (out * pricing.imageOutputPerMTok +
      textIn * (pricing.textInputPerMTok ?? 0) +
      imgIn * (pricing.imageInputPerMTok ?? 0)) /
    1e6;

  return round3(usd);
}
