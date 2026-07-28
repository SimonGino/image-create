/**
 * Google Gemini adapter (SPEC §3), via the `generate_content` path (api-facts
 * §1 — SDK-supported; Interactions API is the future switch). Honors a custom
 * base URL (proxy / relay) through the SDK's httpOptions.
 *
 * These models return ONE image per call — this adapter always yields a single
 * image; "n images" is handled upstream by concurrent calls (see the
 * orchestration fan-out). Reference inputs go in as inlineData parts; no mask.
 *
 * Capability rules live in the metadata (./models.ts), enforced for every
 * provider by @/providers/validate — this file is only the call.
 */

import { GoogleGenAI, type Part } from "@google/genai";

import { getProviderConfig } from "@/lib/credentials";
import { AuthError, errorFromHttpStatus, ProviderError, TimeoutError } from "@/providers/errors";
import type {
  GenerateRequest,
  GenerateResult,
  GenerationUsage,
  ImageProviderAdapter,
  ModelDescriptor,
  ProviderId,
} from "@/providers/types";
import { GOOGLE_MODELS } from "./models";

const REQUEST_TIMEOUT_MS = Number(process.env.GOOGLE_TIMEOUT_MS ?? 120_000);

interface ModalityTokens {
  modality?: unknown;
  tokenCount?: number;
}

function tokensForModality(details: ModalityTokens[] | undefined, modality: string): number | undefined {
  return details?.find((d) => String(d.modality).toUpperCase() === modality)?.tokenCount;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

export class GoogleAdapter implements ImageProviderAdapter {
  readonly providerId: ProviderId = "google";

  listModels(): ModelDescriptor[] {
    return GOOGLE_MODELS;
  }

  private getModel(modelId: string): ModelDescriptor | undefined {
    return GOOGLE_MODELS.find((m) => m.id === modelId);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const model = this.getModel(req.modelId);
    if (!model) {
      throw new ProviderError(`Unknown Gemini model: ${req.modelId}`, { providerId: this.providerId });
    }
    if (req.sizeSpec.kind !== "ratio") {
      throw new ProviderError("Gemini requires an aspect-ratio size", { providerId: this.providerId });
    }

    const { apiKey, baseUrl } = getProviderConfig("google");
    if (!apiKey) {
      throw new AuthError("No Google API key configured. Add one in Settings or .env.", {
        providerId: this.providerId,
      });
    }

    const client = new GoogleGenAI({
      apiKey,
      httpOptions: baseUrl ? { baseUrl, timeout: REQUEST_TIMEOUT_MS } : { timeout: REQUEST_TIMEOUT_MS },
    });

    const parts: Part[] = [{ text: req.prompt }];
    for (const ref of req.refImages ?? []) {
      parts.push({ inlineData: { mimeType: ref.mimeType || "image/png", data: ref.data } });
    }

    const started = Date.now();
    try {
      const response = await client.models.generateContent({
        model: req.modelId,
        contents: [{ role: "user", parts }],
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio: req.sizeSpec.aspectRatio,
            imageSize: req.sizeSpec.imageSize,
          },
        },
      });

      const responseParts = response.candidates?.[0]?.content?.parts ?? [];
      const images = responseParts
        .filter((p): p is Part & { inlineData: { data: string; mimeType?: string } } =>
          typeof p.inlineData?.data === "string",
        )
        .map((p) => ({ data: p.inlineData.data, mimeType: p.inlineData.mimeType ?? "image/png" }));

      if (images.length === 0) {
        const kinds =
          responseParts
            .map((p) => (p.text !== undefined ? "text" : p.inlineData ? "inlineData" : "other"))
            .join(",") || "none";
        const finish = String(response.candidates?.[0]?.finishReason ?? "n/a");
        const hints: Record<string, string> = {
          NO_IMAGE:
            "模型判定此提示词不产图(常见于提示词在要文本/代码而非图像,或要求过于复杂)。直接描述要画的图,或改用 gemini-3-pro-image。",
          PROHIBITED_CONTENT: "内容被安全策略拦截。",
          SAFETY: "内容被安全策略拦截。",
          IMAGE_SAFETY: "生成的图像被安全策略拦截。",
          RECITATION: "命中版权 / 复述过滤。",
          MAX_TOKENS: "输出被 token 上限截断,未产出图像。",
        };
        const hint = hints[finish];
        throw new ProviderError(
          `Gemini 未返回图像 (finishReason: ${finish}; parts: ${kinds})${hint ? " — " + hint : ""}`,
          { providerId: this.providerId, raw: response },
        );
      }

      const meta = response.usageMetadata;
      const usage: GenerationUsage = {
        textInputTokens:
          tokensForModality(meta?.promptTokensDetails, "TEXT") ?? meta?.promptTokenCount,
        imageInputTokens: tokensForModality(meta?.promptTokensDetails, "IMAGE"),
        imageOutputTokens:
          tokensForModality(meta?.candidatesTokensDetails, "IMAGE") ?? meta?.candidatesTokenCount,
      };

      return { images, usage, timingMs: Date.now() - started };
    } catch (err) {
      if (err instanceof ProviderError) throw err;

      const message = err instanceof Error ? err.message : "Gemini request failed";
      if (/abort|timed?\s*out|deadline/i.test(message)) {
        throw new TimeoutError(`Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms`, {
          providerId: this.providerId,
          cause: err,
        });
      }
      const status = statusOf(err);
      if (status !== undefined) {
        throw errorFromHttpStatus(status, message, { providerId: this.providerId, raw: err });
      }
      throw new ProviderError(message, { providerId: this.providerId, cause: err });
    }
  }
}
