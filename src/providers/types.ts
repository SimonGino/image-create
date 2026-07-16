/**
 * Provider / model abstraction — the core contract (SPEC §3).
 *
 * A single set of capability + pricing metadata drives three things at once:
 *   - the dynamic UI parameter panel (SPEC §7),
 *   - pre-flight validation (this module's adapters), and
 *   - cost estimation (SPEC §6, see ./pricing.ts).
 *
 * Adding a third provider = implement one `ImageProviderAdapter` + register its
 * `ModelDescriptor[]` in ./registry.ts. Nothing above this layer changes.
 */

/** Add a third provider by adding a literal to this union. */
export type ProviderId = "openai" | "google";

/** Text-to-image vs. reference-image-to-image. */
export type Mode = "t2i" | "reference";

export type Quality = "low" | "medium" | "high" | "auto";
export type OutputFormat = "png" | "jpeg" | "webp";

/** Gemini aspect ratios (SPEC §3, api-facts §1). */
export type AspectRatio =
  | "1:1"
  | "3:2"
  | "2:3"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";

/** Gemini image-size tiers. */
export type ImageSizeTier = "0.5K" | "1K" | "2K" | "4K";

/**
 * Discriminated union so each provider's size model maps losslessly:
 * OpenAI thinks in pixels, Gemini in aspect-ratio + size tier.
 */
export type SizeSpec =
  | { kind: "pixels"; width: number; height: number }
  | { kind: "ratio"; aspectRatio: AspectRatio; imageSize: ImageSizeTier };

/** One reference / mask input image (base64 payload). */
export interface RefImage {
  data: string; // base64 (no data: prefix)
  mimeType: string;
  role?: "image" | "mask";
}

/**
 * Declarative schema for a provider-private parameter. Drives dynamic UI
 * rendering + validation of `GenerateRequest.providerParams`.
 */
export type ParamSchema =
  | { key: string; label: string; type: "boolean"; default?: boolean; description?: string }
  | {
      key: string;
      label: string;
      type: "number";
      min?: number;
      max?: number;
      step?: number;
      default?: number;
      description?: string;
    }
  | {
      key: string;
      label: string;
      type: "enum";
      options: { value: string; label: string }[];
      default?: string;
      description?: string;
    }
  | { key: string; label: string; type: "string"; default?: string; description?: string };

export interface ModelCapabilities {
  modes: Mode[];
  /** OpenAI: multiple ref images (mask limited to the first); Gemini 3-pro=14 / 2.5=3. */
  maxRefImages: number;
  /** OpenAI true / Gemini false. */
  supportsMask: boolean;
  /** OpenAI true / Gemini false (api-facts §2). */
  supportsN: boolean;
  /** Gemini = 1. */
  maxN: number;
  sizeSpecKind: "pixels" | "ratio";
  /** OpenAI: enumerated "WxH" pixel sizes (UI presets). */
  pixelSizes?: string[];
  /** OpenAI gpt-image-2: any resolution within bounds — `pixelSizes` are presets, not a whitelist. */
  arbitraryPixelSize?: boolean;
  /** Gemini. */
  aspectRatios?: AspectRatio[];
  imageSizeTiers?: ImageSizeTier[];
  outputFormats: OutputFormat[];
  qualities?: Quality[];
  /** Provider-private params, declarative — drives UI + validation. */
  extraParams?: ParamSchema[];
}

/**
 * Pricing metadata (token-based for both providers). Feeds cost estimation (SPEC §6).
 * `perImageTable` keys are "<WxH>:<quality>" (e.g. "1024x1024:high"); present for
 * gpt-image-1.5 (official table), derived for gpt-image-2 (arbitrary sizes → calculator).
 */
export interface ModelPricing {
  unit: "token";
  imageOutputPerMTok: number;
  textInputPerMTok?: number;
  imageInputPerMTok?: number;
  perImageTable?: Record<string, number>;
  /** Output image token counts for 1024² by quality — the estimation basis (api-facts §4b). */
  outputTokens1024?: Partial<Record<Quality, number>>;
  /** True when per-image dollar figures are derived, not officially published (api-facts §4d). */
  derived?: boolean;
}

export interface ModelDescriptor {
  id: string;
  providerId: ProviderId;
  label: string;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  /** Optional human note surfaced in the UI (e.g. verification requirement). */
  note?: string;
}

export interface GenerateRequest {
  providerId: ProviderId;
  modelId: string;
  mode: Mode;
  prompt: string;
  refImages?: RefImage[];
  sizeSpec: SizeSpec;
  n?: number;
  quality?: Quality;
  outputFormat?: OutputFormat;
  /** Provider-private escape hatch, validated against `capabilities.extraParams`. */
  providerParams?: Record<string, unknown>;
}

export interface GeneratedImage {
  data: string; // base64
  mimeType: string;
  width?: number;
  height?: number;
}

export interface GenerationUsage {
  textInputTokens?: number;
  imageInputTokens?: number;
  imageOutputTokens?: number;
}

export interface GenerateResult {
  images: GeneratedImage[];
  usage: GenerationUsage;
  /** Cost derived from returned usage × pricing (SPEC §6); "actual" once we have real tokens. */
  costEstimateUSD?: number;
  timingMs: number;
  /** Raw provider response, kept for debugging / interleaved outputs. */
  raw?: unknown;
}

export interface ValidationIssue {
  path?: string;
  code: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

export interface ImageProviderAdapter {
  readonly providerId: ProviderId;
  listModels(): ModelDescriptor[];
  /** Pre-flight check against capabilities (SPEC §3). */
  validate(req: GenerateRequest): ValidationResult;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
