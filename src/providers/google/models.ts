/**
 * Google Gemini image model metadata (SPEC §8).
 *
 * Size is ratio-based (aspect_ratio + image_size). No native multi-image: these
 * models produce ONE image per call, so "n images" is done by the orchestration
 * layer firing N concurrent generate() calls (supportsN=false / maxN=1).
 *
 * Pricing is OFFICIAL (verified 2026-07-16):
 *   - ai.google.dev/gemini-api/docs/pricing
 *   - cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
 * Image OUTPUT token rates: 3-pro=$120/1M, 3.1-flash=$60/1M, 3.1-flash-lite=$30/1M.
 * INPUT tokens (text + image) bill at ~$2/1M. `perImageTable` holds the official
 * per-image $ by resolution tier (drives the pre-flight estimate); actual cost is
 * recomputed from returned usage tokens.
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

const INPUT_PER_MTOK = 2; // text + image input, ~$2/1M

export const GOOGLE_MODELS: ModelDescriptor[] = [
  {
    // Relay serves Pro under the -preview id (same pattern as flash).
    id: "gemini-3-pro-image-preview",
    providerId: "google",
    label: "Gemini 3 Pro Image (Nano Banana Pro)",
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 14, // api-facts §1
      supportsMask: false, // Gemini has no mask
      supportsN: false, // one image per call → orchestration fans out
      maxN: 1,
      sizeSpecKind: "ratio",
      aspectRatios: ALL_ASPECT_RATIOS,
      imageSizeTiers: ["1K", "2K", "4K"] as ImageSizeTier[],
      outputFormats: OUTPUT_FORMATS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 120, // 1120 tok → $0.134
      imageInputPerMTok: INPUT_PER_MTOK,
      textInputPerMTok: INPUT_PER_MTOK,
      perImageTable: { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
    },
  },
  {
    // Relay serves this under the -preview id (confirmed against the user's endpoint).
    id: "gemini-3.1-flash-image-preview",
    providerId: "google",
    label: "Gemini 3.1 Flash Image (Nano Banana 2)",
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 14,
      supportsMask: false,
      supportsN: false,
      maxN: 1,
      sizeSpecKind: "ratio",
      aspectRatios: ALL_ASPECT_RATIOS,
      imageSizeTiers: ["0.5K", "1K", "2K", "4K"] as ImageSizeTier[],
      outputFormats: OUTPUT_FORMATS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 60, // 1120 tok (1K) → $0.067
      imageInputPerMTok: INPUT_PER_MTOK,
      textInputPerMTok: INPUT_PER_MTOK,
      perImageTable: { "0.5K": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 },
    },
  },
  {
    id: "gemini-3.1-flash-lite-image",
    providerId: "google",
    label: "Gemini 3.1 Flash Lite Image",
    capabilities: {
      modes: ["t2i", "reference"],
      maxRefImages: 6,
      supportsMask: false,
      supportsN: false,
      maxN: 1,
      sizeSpecKind: "ratio",
      aspectRatios: ALL_ASPECT_RATIOS,
      imageSizeTiers: ["1K"] as ImageSizeTier[], // 1K only
      outputFormats: OUTPUT_FORMATS,
    },
    pricing: {
      unit: "token",
      imageOutputPerMTok: 30, // 1120 tok → $0.034
      imageInputPerMTok: INPUT_PER_MTOK,
      textInputPerMTok: INPUT_PER_MTOK,
      perImageTable: { "1K": 0.034 },
    },
  },
];
