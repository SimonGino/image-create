/**
 * OpenAI gpt-image adapter (SPEC §3). Synchronous request/response.
 *   - t2i        → POST /v1/images/generations (JSON)
 *   - reference  → POST /v1/images/edits (multipart)
 * Both return base64 images + token usage. Errors are mapped to the unified
 * taxonomy; any 403 becomes AuthError (SPEC §5). Reference mode is NOT retried
 * automatically — it may already have been billed (SPEC §3).
 *
 * Capability rules live in the metadata (./models.ts), enforced for every
 * provider by @/providers/validate — this file is only the call.
 */

import { getProviderConfig } from "@/lib/credentials";
import {
  AuthError,
  errorFromHttpStatus,
  ProviderError,
  TimeoutError,
  ValidationError,
} from "@/providers/errors";
import { pixelSizeKey } from "@/providers/request";
import type {
  GenerateRequest,
  GenerateResult,
  GenerationUsage,
  ImageProviderAdapter,
  ModelDescriptor,
  OutputFormat,
  ProviderId,
} from "@/providers/types";
import { OPENAI_MODELS } from "./models";

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000);

/** Resolve the base URL: configured (proxy / relay / custom gateway) or official. */
function resolveBaseUrl(baseUrl: string | undefined): string {
  return baseUrl?.replace(/\/+$/, "") || DEFAULT_OPENAI_BASE;
}

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

export class OpenAIAdapter implements ImageProviderAdapter {
  readonly providerId: ProviderId = "openai";

  listModels(): ModelDescriptor[] {
    return OPENAI_MODELS;
  }

  private getModel(modelId: string): ModelDescriptor | undefined {
    return OPENAI_MODELS.find((m) => m.id === modelId);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = this.getModel(req.modelId);
    if (!model) {
      throw new ValidationError(`Unknown OpenAI model: ${req.modelId}`, [
        { path: "modelId", code: "unknown_model", message: req.modelId },
      ]);
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

      return { images, usage, timingMs: Date.now() - started };
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
      ...(req.sizeSpec.kind === "pixels"
        ? { size: pixelSizeKey(req.sizeSpec.width, req.sizeSpec.height) }
        : {}),
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
    if (req.sizeSpec.kind === "pixels")
      form.append("size", pixelSizeKey(req.sizeSpec.width, req.sizeSpec.height));
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
