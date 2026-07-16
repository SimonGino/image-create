/**
 * OpenAI gpt-image model metadata (SPEC §8, api-facts §4).
 *
 * Pricing is token-based ($/1M tokens). gpt-image-1.5 has an official per-image
 * table; gpt-image-2 supports arbitrary resolution so its per-image figures are
 * DERIVED (api-facts §4d) — the actual cost is always recomputed from the usage
 * tokens the API returns.
 */

import type { ModelDescriptor, OutputFormat, Quality, ParamSchema } from "../types";

const OUTPUT_FORMATS: OutputFormat[] = ["png", "jpeg", "webp"];
const QUALITIES: Quality[] = ["low", "medium", "high", "auto"];

// Official output-image token counts for 1024² (api-facts §4b).
const OUTPUT_TOKENS_1024 = { low: 272, medium: 1056, high: 4160 } as const;

const PIXEL_SIZE_PRESETS = ["1024x1024", "1024x1536", "1536x1024"];

// Shared provider-private params (declarative → drives UI panel + validation).
const OPENAI_EXTRA_PARAMS: ParamSchema[] = [
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
];

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
      pixelSizes: PIXEL_SIZE_PRESETS,
      arbitraryPixelSize: true,
      outputFormats: OUTPUT_FORMATS,
      qualities: QUALITIES,
      extraParams: OPENAI_EXTRA_PARAMS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 30,
      textInputPerMTok: 5,
      imageInputPerMTok: 8,
      outputTokens1024: OUTPUT_TOKENS_1024,
      // Derived from 1024² token tiers × $30/1M (api-facts §4d) — calculator is authoritative.
      perImageTable: {
        "1024x1024:low": 0.008,
        "1024x1024:medium": 0.032,
        "1024x1024:high": 0.125,
      },
      derived: true,
    },
  },
  {
    id: "gpt-image-1.5",
    providerId: "openai",
    label: "GPT Image 1.5",
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 16,
      supportsMask: true,
      supportsN: true,
      maxN: 10,
      sizeSpecKind: "pixels",
      pixelSizes: PIXEL_SIZE_PRESETS,
      outputFormats: OUTPUT_FORMATS,
      qualities: QUALITIES,
      extraParams: OPENAI_EXTRA_PARAMS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 32,
      textInputPerMTok: 5,
      imageInputPerMTok: 8,
      outputTokens1024: OUTPUT_TOKENS_1024,
      // Official per-image table (api-facts §4c).
      perImageTable: {
        "1024x1024:low": 0.009,
        "1024x1024:medium": 0.034,
        "1024x1024:high": 0.133,
        "1024x1536:low": 0.013,
        "1024x1536:medium": 0.05,
        "1024x1536:high": 0.2,
        "1536x1024:low": 0.013,
        "1536x1024:medium": 0.05,
        "1536x1024:high": 0.2,
      },
    },
  },
  {
    id: "gpt-image-1-mini",
    providerId: "openai",
    label: "GPT Image 1 Mini",
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 16,
      supportsMask: true,
      supportsN: true,
      maxN: 10,
      sizeSpecKind: "pixels",
      pixelSizes: PIXEL_SIZE_PRESETS,
      outputFormats: OUTPUT_FORMATS,
      qualities: QUALITIES,
      extraParams: OPENAI_EXTRA_PARAMS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 8,
      textInputPerMTok: 2,
      imageInputPerMTok: 2.5,
      outputTokens1024: OUTPUT_TOKENS_1024,
    },
  },
];
