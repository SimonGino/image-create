/**
 * Capability validation (SPEC §3): does this request fit what the model says it
 * can do? One interpreter for every provider, because the rules were already
 * written down — in `ModelCapabilities`. An adapter re-checking them by hand is
 * copying a decision it doesn't own, which is how the two adapters ended up
 * with ~110 lines of the same seven rules and only one of them checking
 * `providerParams` at all.
 *
 * So adapters no longer carry a `validate()`: the orchestrator runs this once,
 * before it touches the db (services/generation.ts). Adding a provider means
 * writing metadata, not another interpreter.
 *
 * Rules that are NOT here, on purpose:
 *   - request *shape* (types, ranges of the JSON itself) — that's the zod
 *     boundary in @/lib/request-schema, above this.
 *   - anything the provider only knows at call time (content policy, quota) —
 *     that comes back as an ImageProviderError from generate().
 *
 * The mirror of this module is `clampRequest` (./request.ts), which fits a
 * request to the same rules instead of reporting on it; scripts/request.test.ts
 * asserts the two agree for every model.
 */

import { effectiveMaxN, pixelSizeKey } from "./request";
import type {
  GenerateRequest,
  ModelDescriptor,
  ParamSchema,
  RefImage,
  ValidationIssue,
  ValidationResult,
} from "./types";

/** Provider-private params, checked against their declared schema. */
function checkProviderParams(
  schemas: ParamSchema[] | undefined,
  params: Record<string, unknown> | undefined,
  issues: ValidationIssue[],
): void {
  if (!params) return;
  const byKey = new Map((schemas ?? []).map((s) => [s.key, s]));
  for (const [key, value] of Object.entries(params)) {
    const schema = byKey.get(key);
    if (!schema) continue; // unknown keys are allowed (documented escape hatch)
    const path = `providerParams.${key}`;
    if (schema.type === "enum" && !schema.options.some((o) => o.value === value)) {
      issues.push({ path, code: "enum", message: `${key} must be one of the allowed values` });
    } else if (schema.type === "number") {
      if (typeof value !== "number") {
        issues.push({ path, code: "type", message: `${key} must be a number` });
      } else {
        if (schema.min !== undefined && value < schema.min)
          issues.push({ path, code: "min", message: `${key} must be ≥ ${schema.min}` });
        if (schema.max !== undefined && value > schema.max)
          issues.push({ path, code: "max", message: `${key} must be ≤ ${schema.max}` });
      }
    } else if (schema.type === "boolean" && typeof value !== "boolean") {
      issues.push({ path, code: "type", message: `${key} must be a boolean` });
    } else if (schema.type === "string" && typeof value !== "string") {
      issues.push({ path, code: "type", message: `${key} must be a string` });
    }
  }
}

function checkSizeSpec(model: ModelDescriptor, req: GenerateRequest, issues: ValidationIssue[]): void {
  const caps = model.capabilities;

  if (req.sizeSpec.kind !== caps.sizeSpecKind) {
    issues.push({
      path: "sizeSpec",
      code: "wrong_size_kind",
      message:
        caps.sizeSpecKind === "pixels"
          ? `${model.label} expects a pixel size`
          : `${model.label} expects an aspect-ratio size`,
    });
    return; // the other size rules can't be read against the wrong arm
  }

  if (req.sizeSpec.kind === "pixels") {
    const { width, height } = req.sizeSpec;
    const bounds = caps.pixelBounds;
    if (bounds) {
      // Free-form resolution: `pixelSizes` are presets, not a whitelist.
      if (width < bounds.min || height < bounds.min || width > bounds.max || height > bounds.max) {
        issues.push({
          path: "sizeSpec",
          code: "out_of_bounds",
          message: `Each side must be ${bounds.min}–${bounds.max}px`,
        });
      }
    } else if (caps.pixelSizes && !caps.pixelSizes.includes(pixelSizeKey(width, height))) {
      issues.push({
        path: "sizeSpec",
        code: "unsupported_size",
        message: `${model.label} supports: ${caps.pixelSizes.join(", ")}`,
      });
    }
    return;
  }

  if (caps.aspectRatios && !caps.aspectRatios.includes(req.sizeSpec.aspectRatio)) {
    issues.push({
      path: "sizeSpec.aspectRatio",
      code: "unsupported_aspect",
      message: `Supported: ${caps.aspectRatios.join(", ")}`,
    });
  }
  if (caps.imageSizeTiers && !caps.imageSizeTiers.includes(req.sizeSpec.imageSize)) {
    issues.push({
      path: "sizeSpec.imageSize",
      code: "unsupported_size",
      message: `${model.label} supports: ${caps.imageSizeTiers.join(", ")}`,
    });
  }
}

function checkRefImages(model: ModelDescriptor, req: GenerateRequest, issues: ValidationIssue[]): void {
  const caps = model.capabilities;
  const refs: RefImage[] = req.refImages ?? [];

  if (req.mode !== "reference") {
    if (refs.length > 0) {
      issues.push({
        path: "refImages",
        code: "unexpected",
        message: "Reference images are only used in reference mode",
      });
    }
    return;
  }

  const images = refs.filter((r) => r.role !== "mask");
  const masks = refs.filter((r) => r.role === "mask");

  if (images.length === 0) {
    issues.push({ path: "refImages", code: "required", message: "Reference mode needs at least one image" });
  }
  if (images.length > caps.maxRefImages) {
    issues.push({
      path: "refImages",
      code: "too_many",
      message: `At most ${caps.maxRefImages} reference images`,
    });
  }
  if (masks.length > 0 && !caps.supportsMask) {
    issues.push({ path: "refImages", code: "no_mask", message: `${model.label} does not support masks` });
  }
  if (masks.length > 1) {
    issues.push({ path: "refImages", code: "too_many_masks", message: "Mask is limited to the first image" });
  }
}

/**
 * The pre-flight check every request goes through, for every provider.
 * Collects all issues rather than failing on the first, so the console can show
 * the whole list.
 */
export function validateAgainstCapabilities(
  model: ModelDescriptor,
  req: GenerateRequest,
): ValidationResult {
  const caps = model.capabilities;
  const issues: ValidationIssue[] = [];

  if (!req.prompt || req.prompt.trim().length === 0) {
    issues.push({ path: "prompt", code: "required", message: "Prompt is required" });
  }

  if (!caps.modes.includes(req.mode)) {
    issues.push({
      path: "mode",
      code: "unsupported_mode",
      message: `${model.label} does not support mode '${req.mode}'`,
    });
  }

  checkSizeSpec(model, req, issues);
  checkRefImages(model, req, issues);

  // n — a model without native `n` still delivers N images, via the
  // orchestrator's fan-out, so the ceiling is the app's not the provider's.
  if (req.n !== undefined) {
    const maxN = effectiveMaxN(model);
    if (!Number.isInteger(req.n)) {
      issues.push({ path: "n", code: "type", message: "n must be a whole number" });
    } else if (req.n < 1) {
      issues.push({ path: "n", code: "min", message: "n must be ≥ 1" });
    } else if (req.n > maxN) {
      issues.push({ path: "n", code: "max", message: `At most ${maxN} images per request` });
    }
  }

  if (req.outputFormat && !caps.outputFormats.includes(req.outputFormat)) {
    issues.push({
      path: "outputFormat",
      code: "unsupported_format",
      message: `Supported: ${caps.outputFormats.join(", ")}`,
    });
  }

  if (req.quality && (!caps.qualities || !caps.qualities.includes(req.quality))) {
    issues.push({
      path: "quality",
      code: "unsupported_quality",
      message: caps.qualities
        ? `Supported: ${caps.qualities.join(", ")}`
        : `${model.label} has no quality setting`,
    });
  }

  checkProviderParams(caps.extraParams, req.providerParams, issues);

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
