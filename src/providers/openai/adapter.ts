/**
 * OpenAI gpt-image adapter (SPEC §3). Synchronous request/response.
 *   - t2i        → POST /v1/images/generations (JSON)
 *   - reference  → POST /v1/images/edits (multipart)
 * Both return base64 images + token usage. Errors are mapped to the unified
 * taxonomy; any 403 becomes AuthError (SPEC §5). Reference mode is NOT retried
 * automatically — it may already have been billed (SPEC §3).
 */

import { getProviderConfig } from "@/lib/credentials";
import {
  AuthError,
  errorFromHttpStatus,
  ProviderError,
  TimeoutError,
  ValidationError,
} from "@/providers/errors";
import { actualCostFromUsage } from "@/providers/pricing";
import type {
  GenerateRequest,
  GenerateResult,
  GenerationUsage,
  ImageProviderAdapter,
  ModelDescriptor,
  OutputFormat,
  ParamSchema,
  ProviderId,
  ValidationIssue,
  ValidationResult,
} from "@/providers/types";
import { OPENAI_MODELS } from "./models";

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000);

/** Resolve the base URL: configured (proxy / relay / custom gateway) or official. */
function resolveBaseUrl(baseUrl: string | undefined): string {
  return baseUrl?.replace(/\/+$/, "") || DEFAULT_OPENAI_BASE;
}

// gpt-image-2 arbitrary-resolution bounds (single side), used when validating custom sizes.
const MIN_SIDE = 256;
const MAX_SIDE = 3840;

interface OpenAIImageResponse {
  data?: { b64_json?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
}

function mimeForFormat(format: OutputFormat | undefined): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  return new Blob([Buffer.from(base64, "base64")], { type: mimeType });
}

function validateProviderParams(
  schemas: ParamSchema[] | undefined,
  params: Record<string, unknown> | undefined,
  issues: ValidationIssue[],
): void {
  if (!params) return;
  const byKey = new Map((schemas ?? []).map((s) => [s.key, s]));
  for (const [key, value] of Object.entries(params)) {
    const schema = byKey.get(key);
    if (!schema) continue; // unknown keys are allowed (escape hatch)
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
    }
  }
}

export class OpenAIAdapter implements ImageProviderAdapter {
  readonly providerId: ProviderId = "openai";

  listModels(): ModelDescriptor[] {
    return OPENAI_MODELS;
  }

  private getModel(modelId: string): ModelDescriptor | undefined {
    return OPENAI_MODELS.find((m) => m.id === modelId);
  }

  validate(req: GenerateRequest): ValidationResult {
    const issues: ValidationIssue[] = [];
    const model = this.getModel(req.modelId);
    if (!model) {
      return { ok: false, issues: [{ path: "modelId", code: "unknown_model", message: `Unknown OpenAI model: ${req.modelId}` }] };
    }
    const caps = model.capabilities;

    if (!req.prompt || req.prompt.trim().length === 0) {
      issues.push({ path: "prompt", code: "required", message: "Prompt is required" });
    }

    if (!caps.modes.includes(req.mode)) {
      issues.push({ path: "mode", code: "unsupported_mode", message: `${model.label} does not support mode '${req.mode}'` });
    }

    // Size — OpenAI is pixel-based.
    if (req.sizeSpec.kind !== "pixels") {
      issues.push({ path: "sizeSpec", code: "wrong_size_kind", message: "OpenAI expects a pixel size" });
    } else {
      const { width, height } = req.sizeSpec;
      const key = `${width}x${height}`;
      if (caps.arbitraryPixelSize) {
        if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) {
          issues.push({ path: "sizeSpec", code: "out_of_bounds", message: `Each side must be ${MIN_SIDE}–${MAX_SIDE}px` });
        }
      } else if (caps.pixelSizes && !caps.pixelSizes.includes(key)) {
        issues.push({ path: "sizeSpec", code: "unsupported_size", message: `${model.label} supports: ${caps.pixelSizes.join(", ")}` });
      }
    }

    // n
    if (req.n !== undefined) {
      if (req.n < 1) {
        issues.push({ path: "n", code: "min", message: "n must be ≥ 1" });
      } else if (!caps.supportsN && req.n > 1) {
        issues.push({ path: "n", code: "unsupported_n", message: `${model.label} does not support n > 1` });
      } else if (req.n > caps.maxN) {
        issues.push({ path: "n", code: "max", message: `n must be ≤ ${caps.maxN}` });
      }
    }

    // Reference images
    if (req.mode === "reference") {
      const refs = req.refImages ?? [];
      const images = refs.filter((r) => r.role !== "mask");
      const masks = refs.filter((r) => r.role === "mask");
      if (images.length === 0) {
        issues.push({ path: "refImages", code: "required", message: "Reference mode needs at least one image" });
      }
      if (images.length > caps.maxRefImages) {
        issues.push({ path: "refImages", code: "too_many", message: `At most ${caps.maxRefImages} reference images` });
      }
      if (masks.length > 0 && !caps.supportsMask) {
        issues.push({ path: "refImages", code: "no_mask", message: `${model.label} does not support masks` });
      }
      if (masks.length > 1) {
        issues.push({ path: "refImages", code: "too_many_masks", message: "Mask is limited to the first image" });
      }
    }

    if (req.outputFormat && !caps.outputFormats.includes(req.outputFormat)) {
      issues.push({ path: "outputFormat", code: "unsupported_format", message: `Supported: ${caps.outputFormats.join(", ")}` });
    }
    if (req.quality && caps.qualities && !caps.qualities.includes(req.quality)) {
      issues.push({ path: "quality", code: "unsupported_quality", message: `Supported: ${caps.qualities.join(", ")}` });
    }

    validateProviderParams(caps.extraParams, req.providerParams, issues);

    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = this.getModel(req.modelId);
    if (!model) {
      throw new ValidationError(`Unknown OpenAI model: ${req.modelId}`, [
        { path: "modelId", code: "unknown_model", message: req.modelId },
      ]);
    }

    const check = this.validate(req);
    if (!check.ok) {
      throw new ValidationError("Request failed capability validation", check.issues, {
        providerId: this.providerId,
      });
    }

    const { apiKey, baseUrl } = getProviderConfig("openai");
    if (!apiKey) {
      throw new AuthError("No OpenAI API key configured. Add one in Settings or .env.", {
        providerId: this.providerId,
      });
    }
    const base = resolveBaseUrl(baseUrl);

    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await this.dispatch(req, apiKey, base, controller.signal);
      const json = (await res.json()) as OpenAIImageResponse & { error?: { message?: string } };

      if (!res.ok) {
        const message = json?.error?.message ?? `OpenAI request failed (${res.status})`;
        throw errorFromHttpStatus(res.status, message, { providerId: this.providerId, raw: json });
      }

      const mimeType = mimeForFormat(req.outputFormat);
      const dims = req.sizeSpec.kind === "pixels" ? { width: req.sizeSpec.width, height: req.sizeSpec.height } : {};
      const images = (json.data ?? [])
        .filter((d): d is { b64_json: string } => typeof d.b64_json === "string")
        .map((d) => ({ data: d.b64_json, mimeType, ...dims }));

      if (images.length === 0) {
        throw new ProviderError("OpenAI returned no image data", { providerId: this.providerId, raw: json });
      }

      const usage: GenerationUsage = {
        textInputTokens: json.usage?.input_tokens_details?.text_tokens,
        imageInputTokens: json.usage?.input_tokens_details?.image_tokens,
        imageOutputTokens: json.usage?.output_tokens,
      };

      return {
        images,
        usage,
        costEstimateUSD: actualCostFromUsage(model, usage),
        timingMs: Date.now() - started,
        raw: json,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutError(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms`, {
          providerId: this.providerId,
          cause: err,
        });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private dispatch(
    req: GenerateRequest,
    apiKey: string,
    base: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return req.mode === "reference"
      ? this.callEdits(req, apiKey, base, signal)
      : this.callGenerations(req, apiKey, base, signal);
  }

  private callGenerations(
    req: GenerateRequest,
    apiKey: string,
    base: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: req.modelId,
      prompt: req.prompt,
      n: req.n ?? 1,
      ...(req.sizeSpec.kind === "pixels" ? { size: `${req.sizeSpec.width}x${req.sizeSpec.height}` } : {}),
      ...(req.quality ? { quality: req.quality } : {}),
      ...(req.outputFormat ? { output_format: req.outputFormat } : {}),
      ...(req.providerParams ?? {}),
    };
    return fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  private callEdits(
    req: GenerateRequest,
    apiKey: string,
    base: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const form = new FormData();
    form.append("model", req.modelId);
    form.append("prompt", req.prompt);
    form.append("n", String(req.n ?? 1));
    if (req.sizeSpec.kind === "pixels") form.append("size", `${req.sizeSpec.width}x${req.sizeSpec.height}`);
    if (req.quality) form.append("quality", req.quality);
    if (req.outputFormat) form.append("output_format", req.outputFormat);

    const refs = req.refImages ?? [];
    let imageIdx = 0;
    for (const ref of refs) {
      const mime = ref.mimeType || "image/png";
      const ext = mime.split("/")[1] ?? "png";
      const blob = base64ToBlob(ref.data, mime);
      if (ref.role === "mask") {
        form.append("mask", blob, `mask.${ext}`);
      } else {
        form.append("image[]", blob, `image_${imageIdx++}.${ext}`);
      }
    }

    for (const [key, value] of Object.entries(req.providerParams ?? {})) {
      form.append(key, typeof value === "string" ? value : String(value));
    }

    return fetch(`${base}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  }
}
