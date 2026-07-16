/**
 * Generation orchestration — the end-to-end path that ties the abstraction to
 * persistence (SPEC §3 + §4 + §6):
 *
 *   validate → insert row (pending, with ≈ estimate) → save ref inputs →
 *   adapter.generate() → write images + thumbnails → record actual usage & cost.
 *
 * The adapter is injectable so this whole chain can be exercised without a live
 * provider call (see scripts/smoke.ts).
 */

import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  generationImages,
  generationRefImages,
  generations,
  type CostSource,
  type GenerationStatus,
} from "@/db/schema";
import { saveGeneratedImage, saveRefImage } from "@/lib/images";
import { ImageProviderError, ProviderError } from "@/providers/errors";
import { actualCostFromUsage, estimateCostUSD } from "@/providers/pricing";
import { getAdapter, hasAdapter } from "@/providers/registry";
import type {
  GenerateRequest,
  GenerateResult,
  GenerationUsage,
  ImageProviderAdapter,
  ModelDescriptor,
} from "@/providers/types";
import { ValidationError } from "@/providers/errors";

export interface GenerationImageSummary {
  idx: number;
  filePath: string;
  thumbPath?: string;
  width?: number;
  height?: number;
  mimeType: string;
}

export interface GenerationSummary {
  generationId: string;
  status: GenerationStatus;
  providerId: GenerateRequest["providerId"];
  modelId: string;
  mode: GenerateRequest["mode"];
  images: GenerationImageSummary[];
  usage: GenerationUsage;
  costUsd?: number;
  costSource?: CostSource;
  timingMs?: number;
}

export interface RunGenerationOptions {
  /** Inject an adapter (tests / smoke) instead of resolving from the registry. */
  adapter?: ImageProviderAdapter;
}

function resolveAdapter(req: GenerateRequest, opts: RunGenerationOptions): ImageProviderAdapter {
  if (opts.adapter) return opts.adapter;
  if (!hasAdapter(req.providerId)) {
    throw new ProviderError(`No adapter registered for provider '${req.providerId}'`);
  }
  return getAdapter(req.providerId);
}

const USAGE_KEYS = ["textInputTokens", "imageInputTokens", "imageOutputTokens"] as const;

/** Merge concurrent single-image results into one logical Generation. */
function mergeResults(parts: GenerateResult[]): GenerateResult {
  const usage: GenerationUsage = {};
  let cost: number | undefined;
  let timingMs = 0;

  for (const part of parts) {
    timingMs = Math.max(timingMs, part.timingMs);
    if (part.costEstimateUSD !== undefined) cost = (cost ?? 0) + part.costEstimateUSD;
    for (const key of USAGE_KEYS) {
      const value = part.usage[key];
      if (value !== undefined) usage[key] = (usage[key] ?? 0) + value;
    }
  }

  return { images: parts.flatMap((p) => p.images), usage, timingMs, costEstimateUSD: cost };
}

/**
 * Run the provider call, satisfying `n`: native batch (OpenAI `n`) in one call,
 * or client-side concurrency (Gemini) firing N single-image calls (SPEC §3).
 */
async function generateImages(
  adapter: ImageProviderAdapter,
  model: ModelDescriptor,
  req: GenerateRequest,
  n: number,
): Promise<GenerateResult> {
  if (model.capabilities.supportsN) {
    return adapter.generate({ ...req, n });
  }
  const shots = await Promise.all(
    Array.from({ length: n }, () => adapter.generate({ ...req, n: 1 })),
  );
  return shots.length === 1 ? shots[0]! : mergeResults(shots);
}

export async function runGeneration(
  req: GenerateRequest,
  opts: RunGenerationOptions = {},
): Promise<GenerationSummary> {
  const adapter = resolveAdapter(req, opts);
  const model: ModelDescriptor | undefined = adapter.listModels().find((m) => m.id === req.modelId);

  const check = adapter.validate(req);
  if (!check.ok) {
    throw new ValidationError("Request failed capability validation", check.issues, {
      providerId: req.providerId,
    });
  }
  if (!model) {
    throw new ValidationError(`Unknown model '${req.modelId}'`, [
      { path: "modelId", code: "unknown_model", message: req.modelId },
    ]);
  }

  const generationId = crypto.randomUUID();
  const n = Math.max(1, req.n ?? 1);
  const estimate = estimateCostUSD(model, req);

  db.insert(generations)
    .values({
      id: generationId,
      providerId: req.providerId,
      modelId: req.modelId,
      mode: req.mode,
      prompt: req.prompt,
      sizeSpec: req.sizeSpec,
      quality: req.quality,
      outputFormat: req.outputFormat,
      nRequested: n,
      providerParams: req.providerParams,
      status: "pending",
      costUsd: estimate,
      costSource: estimate !== undefined ? "estimated" : undefined,
    })
    .run();

  // Persist reference inputs (they're user-provided; keep them regardless of outcome).
  if (req.mode === "reference" && req.refImages?.length) {
    const refRows = [];
    for (let i = 0; i < req.refImages.length; i++) {
      const ref = req.refImages[i]!;
      const filePath = await saveRefImage(generationId, i, ref.data, ref.mimeType);
      refRows.push({ generationId, idx: i, filePath, role: ref.role ?? ("image" as const) });
    }
    if (refRows.length) db.insert(generationRefImages).values(refRows).run();
  }

  try {
    const result = await generateImages(adapter, model, req, n);

    const imageSummaries: GenerationImageSummary[] = [];
    for (let i = 0; i < result.images.length; i++) {
      const img = result.images[i]!;
      const saved = await saveGeneratedImage(generationId, i, img.data, img.mimeType);
      imageSummaries.push({
        idx: i,
        filePath: saved.filePath,
        thumbPath: saved.thumbPath,
        width: saved.width ?? img.width,
        height: saved.height ?? img.height,
        mimeType: img.mimeType,
      });
    }
    if (imageSummaries.length) {
      db.insert(generationImages)
        .values(
          imageSummaries.map((s) => ({
            generationId,
            idx: s.idx,
            filePath: s.filePath,
            thumbPath: s.thumbPath,
            width: s.width,
            height: s.height,
            mimeType: s.mimeType,
          })),
        )
        .run();
    }

    // Actual cost from returned usage is the statistics source of truth (SPEC §6).
    const actualCost = actualCostFromUsage(model, result.usage) ?? result.costEstimateUSD;
    const costSource: CostSource | undefined = actualCost !== undefined ? "actual" : undefined;

    db.update(generations)
      .set({
        status: "success",
        timingMs: result.timingMs,
        textInputTokens: result.usage.textInputTokens,
        imageInputTokens: result.usage.imageInputTokens,
        imageOutputTokens: result.usage.imageOutputTokens,
        costUsd: actualCost,
        costSource,
      })
      .where(eq(generations.id, generationId))
      .run();

    return {
      generationId,
      status: "success",
      providerId: req.providerId,
      modelId: req.modelId,
      mode: req.mode,
      images: imageSummaries,
      usage: result.usage,
      costUsd: actualCost,
      costSource,
      timingMs: result.timingMs,
    };
  } catch (err) {
    const errorCode = err instanceof ImageProviderError ? err.code : "provider";
    db.update(generations)
      .set({ status: "error", errorCode })
      .where(eq(generations.id, generationId))
      .run();
    throw err;
  }
}
