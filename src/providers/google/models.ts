/**
 * Google Gemini image model metadata (SPEC §8, api-facts §1).
 *
 * Size is ratio-based (aspect_ratio + image_size). No native multi-image: these
 * models produce ONE image per call, so "n images" is done by the orchestration
 * layer firing N concurrent generate() calls (supportsN=false / maxN=1).
 *
 * ⚠️ Pricing is PROVISIONAL — Gemini per-image / per-token rates were left as a
 * pre-launch follow-up in the design (SPEC §8: "落地前以官方为准"). imageOutputPerMTok
 * below is a placeholder so actual cost can be computed from returned tokens;
 * no static estimate table until the numbers are confirmed.
 */

import type { AspectRatio, ImageSizeTier, ModelDescriptor, OutputFormat } from "../types";

const ALL_ASPECT_RATIOS: AspectRatio[] = [
  "1:1",
  "3:2",
  "2:3",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

// Gemini returns PNG (with a mandatory SynthID watermark, api-facts §8).
const OUTPUT_FORMATS: OutputFormat[] = ["png"];

const PRICING_TODO =
  "Pricing provisional — confirm official Gemini rates before launch (SPEC §8).";

const HIGH_RES_TIERS: ImageSizeTier[] = ["1K", "2K", "4K"];

export const GOOGLE_MODELS: ModelDescriptor[] = [
  {
    id: "gemini-3-pro-image",
    providerId: "google",
    label: "Gemini 3 Pro Image (Nano Banana Pro)",
    note: PRICING_TODO,
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 14, // api-facts §1
      supportsMask: false, // Gemini has no mask
      supportsN: false, // one image per call → orchestration fans out
      maxN: 1,
      sizeSpecKind: "ratio",
      aspectRatios: ALL_ASPECT_RATIOS,
      imageSizeTiers: HIGH_RES_TIERS,
      outputFormats: OUTPUT_FORMATS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 120, // PROVISIONAL
      derived: true,
    },
  },
  {
    // Relay serves this under the -preview id (confirmed against the user's endpoint).
    id: "gemini-3.1-flash-image-preview",
    providerId: "google",
    label: "Gemini 3.1 Flash Image (Nano Banana 2)",
    note: PRICING_TODO,
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 14,
      supportsMask: false,
      supportsN: false,
      maxN: 1,
      sizeSpecKind: "ratio",
      aspectRatios: ALL_ASPECT_RATIOS,
      imageSizeTiers: HIGH_RES_TIERS,
      outputFormats: OUTPUT_FORMATS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 30, // PROVISIONAL
      derived: true,
    },
  },
  {
    id: "gemini-3.1-flash-lite-image",
    providerId: "google",
    label: "Gemini 3.1 Flash Lite Image",
    note: PRICING_TODO,
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 6,
      supportsMask: false,
      supportsN: false,
      maxN: 1,
      sizeSpecKind: "ratio",
      aspectRatios: ALL_ASPECT_RATIOS,
      imageSizeTiers: ["1K"], // 1K only (SPEC §8)
      outputFormats: OUTPUT_FORMATS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 20, // PROVISIONAL
      derived: true,
    },
  },
];
