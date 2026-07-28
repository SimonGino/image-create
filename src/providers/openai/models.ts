/**
 * OpenAI gpt-image model metadata (SPEC §8, api-facts §4).
 *
 * One model on purpose: gpt-image-2 supersedes 1.5 and 1-mini on quality and is
 * cheaper per image at every tier, so shipping the older ids only widened the
 * model picker. Old Generations keep working — the ledger stores the model id and
 * the cost it was charged, and nothing re-resolves metadata for a past row.
 *
 * Pricing is token-based ($/1M tokens). gpt-image-2 supports arbitrary resolution,
 * so its per-image figures are DERIVED (api-facts §4d) from the 1024² token tiers;
 * the actual cost is always recomputed from the usage tokens the API returns.
 */

import type { ModelDescriptor } from "../types";

export const OPENAI_MODELS: ModelDescriptor[] = [
  {
    id: "gpt-image-2",
    providerId: "openai",
    label: "GPT Image 2",
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 16,
      supportsMask: true,
      supportsN: true,
      maxN: 10,
      sizeSpecKind: "pixels",
      pixelSizes: ["1024x1024", "1024x1536", "1536x1024"],
      // Arbitrary resolution within these per-side bounds (api-facts §4).
      pixelBounds: { min: 256, max: 3840 },
      outputFormats: ["png", "jpeg", "webp"],
      qualities: ["low", "medium", "high", "auto"],
      // Provider-private params, declarative → drives the UI panel + validation.
      extraParams: [
        {
          key: "background",
          label: "Background",
          type: "enum",
          options: [
            { value: "auto", label: "Auto" },
            { value: "transparent", label: "Transparent" },
            { value: "opaque", label: "Opaque" },
          ],
          default: "auto",
          description: "Transparent requires png or webp output.",
        },
        {
          key: "output_compression",
          label: "Compression",
          type: "number",
          min: 0,
          max: 100,
          step: 1,
          description: "0–100, applies to jpeg / webp output only.",
        },
      ],
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 30,
      textInputPerMTok: 5,
      imageInputPerMTok: 8,
      // Official output-image token counts for 1024² (api-facts §4b).
      outputTokens1024: { low: 272, medium: 1056, high: 4160 },
      // Derived from those tiers × $30/1M (api-facts §4d) — calculator is authoritative.
      perImageTable: {
        "1024x1024:low": 0.008,
        "1024x1024:medium": 0.032,
        "1024x1024:high": 0.125,
      },
      derived: true,
    },
  },
];
