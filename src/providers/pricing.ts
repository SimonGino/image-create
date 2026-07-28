/**
 * Cost & usage math (SPEC §6) — the app's only cost owner. Two figures:
 *   - estimate (pre-flight, "≈$"): from pricing metadata + chosen size/quality/n.
 *     Shown in the console/compare panels and written on the pending row.
 *   - actual: from the usage tokens the provider returns — the statistics
 *     source of truth (cost_source = 'actual').
 *
 * Dollars are derived here and nowhere else. Adapters return usage *tokens*;
 * the rates live in the app-owned `ModelDescriptor`, so an adapter pricing its
 * own call would be deciding something it doesn't own — and the orchestrator,
 * holding the same model + usage, would compute the identical number anyway.
 *
 * `resolveCost` owns which of the two figures gets persisted, so `cost_usd`
 * and `cost_source` cannot drift apart at a call site.
 *
 * Currency USD, rounded to $0.001.
 */

import { pixelSizeKey } from "./request";
import type { GenerateRequest, GenerationUsage, ModelDescriptor, Quality } from "./types";

export type CostSource = "estimated" | "actual";

/** The app's single USD rounding — $0.001 precision. */
export function round3(usd: number): number {
  return Math.round(usd * 1000) / 1000;
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
    const key = pixelSizeKey(req.sizeSpec.width, req.sizeSpec.height);
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
 * Actual cost from returned usage tokens (SPEC §6 algorithm).
 *
 * Module-private: callers want the *persisted* figure, which is a decision
 * about actual-vs-estimate — that's `resolveCost`. Linear in every token count,
 * which is why fan-out can be priced once from the summed usage instead of
 * per shot.
 */
function actualCostFromUsage(model: ModelDescriptor, usage: GenerationUsage): number | undefined {
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

/** What gets persisted on a Generation: the figure and where it came from. */
export interface CostDecision {
  costUsd?: number;
  costSource?: CostSource;
}

/**
 * The cost a finished Generation is recorded with (SPEC §6): returned usage
 * tokens win; the pre-flight `estimate` stands when the provider gave no usable
 * token counts; neither means the Generation carries no cost at all.
 *
 * The pair is returned together so no caller can set a source that its figure
 * doesn't support.
 */
export function resolveCost(
  model: ModelDescriptor,
  usage: GenerationUsage,
  estimate: number | undefined,
): CostDecision {
  const actual = actualCostFromUsage(model, usage);
  if (actual !== undefined) return { costUsd: actual, costSource: "actual" };
  if (estimate !== undefined) return { costUsd: estimate, costSource: "estimated" };
  return {};
}
