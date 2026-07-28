/**
 * Provider / model abstraction — the core contract (SPEC §3).
 *
 * A single set of capability + pricing metadata drives four things at once:
 *   - the dynamic UI parameter panel and its defaults (SPEC §7, ./request.ts),
 *   - pre-flight validation (SPEC §3, ./validate.ts),
 *   - the fan-out / batch decision (SPEC §3, services/generation.ts), and
 *   - cost estimation (SPEC §6, ./pricing.ts).
 *
 * Adding a third provider = implement one `ImageProviderAdapter` (models + the
 * call itself) + register it in ./registry.ts. Everything else above is driven
 * by the metadata, so nothing else changes.
 */

/**
 * Add a third provider by adding it here — `ProviderId` is derived, so the
 * union and every list that iterates providers stay in step by construction.
 */
export const PROVIDER_IDS = ["openai", "google"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Text-to-image vs. reference-image-to-image. */
export type Mode = "t2i" | "reference";

/**
 * App-level ceiling on client-side fan-out when a model has no native `n`
 * (Gemini). The orchestrator enforces it; adapter validation and the UI's
 * n-control share the same constant.
 */
export const MAX_FANOUT_N = 8;

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
  /**
   * OpenAI gpt-image-2: any resolution within these per-side bounds, so
   * `pixelSizes` are presets rather than a whitelist. Absent ⇒ presets only.
   * Validation, the size inputs' min/max and clamping all read it from here.
   */
  pixelBounds?: { min: number; max: number };
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
 * `perImageTable` keys are "<WxH>:<quality>" for pixel models (e.g. "1024x1024:high")
 * and the size tier for ratio models ("2K"). Official where the provider publishes
 * one; derived for gpt-image-2, whose arbitrary sizes mean only the calculator is
 * authoritative (`derived: true`).
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

/**
 * What an adapter owes the orchestrator: the images, the provider's own token
 * counts, and how long its call took. Deliberately no cost — dollars are the
 * app's decision, derived from `usage` × `ModelDescriptor.pricing` in exactly
 * one place (./pricing.ts, SPEC §6).
 */
export interface GenerateResult {
  images: GeneratedImage[];
  usage: GenerationUsage;
  timingMs: number;
}

export interface ValidationIssue {
  path?: string;
  code: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

/**
 * All an adapter does: declare its models and make the call. Capability
 * validation is NOT here — it reads the metadata below, so ./validate.ts does it
 * once for every provider (an adapter's own copy could only drift from it).
 */
export interface ImageProviderAdapter {
  readonly providerId: ProviderId;
  listModels(): ModelDescriptor[];
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
