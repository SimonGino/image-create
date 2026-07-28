/**
 * What a valid request looks like for a given model (SPEC §3, §7) — derived
 * from `ModelCapabilities`, so no UI has to mirror capability metadata by hand.
 *
 * Two entry points:
 *   - `defaultRequestFor(model, over)` — a request that passes that model's own
 *     `validate()` out of the box. The console's initial draft, the compare
 *     grid's per-model request, and the one definition of "sensible defaults".
 *   - `clampRequest(model, req)` — carry a draft to another model: keep every
 *     field the new model still accepts, replace only what it can't. Switching
 *     between two pixel models keeps your 1536×1024 and n=4; switching to a
 *     ratio-based model replaces the size and drops `quality`.
 *
 * Reference images are deliberately NOT clamped — silently dropping an image
 * the user attached is worse than the adapter's validation error.
 *
 * Pure functions: no React, no fetch, no db. Tested in scripts/request.test.ts
 * against every registered model's own validate().
 */

import {
  MAX_FANOUT_N,
  type AspectRatio,
  type GenerateRequest,
  type ImageSizeTier,
  type ModelDescriptor,
  type OutputFormat,
  type ParamSchema,
  type Quality,
  type SizeSpec,
} from "./types";

/** A `sizeSpec` in its pixel arm. */
export type PixelSize = Extract<SizeSpec, { kind: "pixels" }>;

/** Provider-private param values the UI can produce. */
export type ParamValue = string | number | boolean;

/**
 * The `n` the app can actually deliver: the provider's native batch, or — when
 * it has no `n` — the orchestrator's client-side fan-out ceiling (SPEC §3).
 * The UI's n control and the adapters' validate() both bound by this.
 */
export function effectiveMaxN(model: ModelDescriptor): number {
  const caps = model.capabilities;
  return caps.supportsN ? caps.maxN : MAX_FANOUT_N;
}

// --------------------------------------------------------- pixel size codec

/**
 * The "WxH" string form used by `capabilities.pixelSizes`, the pricing tables
 * and OpenAI's wire `size` field. One codec, so those three can't drift.
 */
export function pixelSizeKey(width: number, height: number): string {
  return `${width}x${height}`;
}

/** Inverse of `pixelSizeKey`; undefined when the key isn't a "WxH" pair. */
export function parsePixelSize(key: string | undefined): PixelSize | undefined {
  const [w, h] = (key ?? "").split("x").map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return undefined;
  return { kind: "pixels", width: w, height: h };
}

// ------------------------------------------------------------------ defaults

const FALLBACK_PIXELS: PixelSize = { kind: "pixels", width: 1024, height: 1024 };

/**
 * The tier to default to when a model offers several. 1K is the canonical one
 * both providers publish a price for; 0.5K is a preview-grade tier nobody wants
 * by accident.
 */
const PREFERRED_TIER: ImageSizeTier = "1K";

/** png where available: lossless, and the only format every model shares. */
const PREFERRED_FORMAT: OutputFormat = "png";

/** Quality to default to — the visible ceiling, matching what "≈$" quotes. */
const PREFERRED_QUALITY: Quality = "high";

function pick<T>(offered: readonly T[] | undefined, preferred: T, fallback: T): T {
  if (!offered || offered.length === 0) return fallback;
  return offered.includes(preferred) ? preferred : offered[0]!;
}

function defaultSizeSpec(model: ModelDescriptor): SizeSpec {
  const caps = model.capabilities;
  if (caps.sizeSpecKind === "pixels") {
    return parsePixelSize(caps.pixelSizes?.[0]) ?? FALLBACK_PIXELS;
  }
  return {
    kind: "ratio",
    aspectRatio: caps.aspectRatios?.[0] ?? ("1:1" as AspectRatio),
    imageSize: pick(caps.imageSizeTiers, PREFERRED_TIER, PREFERRED_TIER),
  };
}

/** undefined for models that expose no quality control (Gemini). */
function defaultQuality(model: ModelDescriptor): Quality | undefined {
  const { qualities } = model.capabilities;
  return qualities ? pick(qualities, PREFERRED_QUALITY, PREFERRED_QUALITY) : undefined;
}

/** The declared defaults of a model's provider-private params. */
export function defaultProviderParams(model: ModelDescriptor): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const schema of model.capabilities.extraParams ?? []) {
    if (schema.default !== undefined) out[schema.key] = schema.default;
  }
  return out;
}

/**
 * A request this model accepts. `over` supplies what only the caller knows —
 * prompt, mode, n — and is itself clamped, so an out-of-range override can't
 * produce an invalid request.
 */
export function defaultRequestFor(
  model: ModelDescriptor,
  over: Partial<GenerateRequest> = {},
): GenerateRequest {
  const caps = model.capabilities;
  const quality = defaultQuality(model);
  const base: GenerateRequest = {
    providerId: model.providerId,
    modelId: model.id,
    mode: caps.modes[0] ?? "t2i",
    prompt: "",
    sizeSpec: defaultSizeSpec(model),
    n: 1,
    ...(quality ? { quality } : {}),
    outputFormat: pick(caps.outputFormats, PREFERRED_FORMAT, PREFERRED_FORMAT),
    ...(caps.extraParams?.length ? { providerParams: defaultProviderParams(model) } : {}),
  };
  return clampRequest(model, { ...base, ...over });
}

// ------------------------------------------------------------------ clamping

function clampN(model: ModelDescriptor, n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.floor(n)), effectiveMaxN(model));
}

function clampSizeSpec(model: ModelDescriptor, spec: SizeSpec | undefined): SizeSpec {
  const caps = model.capabilities;
  if (!spec || spec.kind !== caps.sizeSpecKind) return defaultSizeSpec(model);

  if (spec.kind === "pixels") {
    const bounds = caps.pixelBounds;
    if (bounds) {
      const side = (v: number) =>
        Number.isFinite(v) ? Math.min(Math.max(Math.round(v), bounds.min), bounds.max) : FALLBACK_PIXELS.width;
      return { kind: "pixels", width: side(spec.width), height: side(spec.height) };
    }
    // Presets only: an off-list size has to snap back.
    const key = pixelSizeKey(spec.width, spec.height);
    return caps.pixelSizes?.includes(key) ? spec : defaultSizeSpec(model);
  }

  return {
    kind: "ratio",
    aspectRatio: caps.aspectRatios?.includes(spec.aspectRatio)
      ? spec.aspectRatio
      : (caps.aspectRatios?.[0] ?? spec.aspectRatio),
    imageSize: caps.imageSizeTiers?.includes(spec.imageSize)
      ? spec.imageSize
      : pick(caps.imageSizeTiers, PREFERRED_TIER, spec.imageSize),
  };
}

/**
 * Keep values whose key the new model also declares (same `type`), and fill in
 * that model's defaults for the rest. Unknown keys are dropped: the escape
 * hatch is for API callers, and a stale key from another provider is noise.
 */
function clampProviderParams(
  schemas: ParamSchema[] | undefined,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!schemas?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const schema of schemas) {
    const carried = params?.[schema.key];
    const compatible =
      (schema.type === "number" && typeof carried === "number") ||
      (schema.type === "boolean" && typeof carried === "boolean") ||
      (schema.type === "string" && typeof carried === "string") ||
      (schema.type === "enum" && schema.options.some((o) => o.value === carried));
    if (compatible) out[schema.key] = carried;
    else if (schema.default !== undefined) out[schema.key] = schema.default;
  }
  return out;
}

/**
 * Fit a request to a model: every field it accepts survives, the rest is
 * replaced by that model's default. Used when the selected model changes and
 * when building a request from arbitrary defaults.
 */
export function clampRequest(model: ModelDescriptor, req: GenerateRequest): GenerateRequest {
  const caps = model.capabilities;
  const quality = caps.qualities
    ? req.quality && caps.qualities.includes(req.quality)
      ? req.quality
      : defaultQuality(model)
    : undefined;
  const outputFormat =
    req.outputFormat && caps.outputFormats.includes(req.outputFormat)
      ? req.outputFormat
      : pick(caps.outputFormats, PREFERRED_FORMAT, PREFERRED_FORMAT);
  const params = clampProviderParams(caps.extraParams, req.providerParams);

  return {
    providerId: model.providerId,
    modelId: model.id,
    mode: caps.modes.includes(req.mode) ? req.mode : (caps.modes[0] ?? req.mode),
    prompt: req.prompt,
    // Ref inputs are validated, never silently trimmed.
    ...(req.refImages ? { refImages: req.refImages } : {}),
    sizeSpec: clampSizeSpec(model, req.sizeSpec),
    n: clampN(model, req.n),
    ...(quality ? { quality } : {}),
    outputFormat,
    ...(params && Object.keys(params).length ? { providerParams: params } : {}),
  };
}
