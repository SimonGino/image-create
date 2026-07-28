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
  type GenerationStatus,
} from "@/db/schema";
import { saveGeneratedImage, saveRefImage } from "@/lib/images";
import { ImageProviderError, ProviderError } from "@/providers/errors";
import { estimateCostUSD, resolveCost, type CostDecision } from "@/providers/pricing";
import { getAdapter, hasAdapter } from "@/providers/registry";
import {
  MAX_FANOUT_N,
  type GenerateRequest,
  type GenerateResult,
  type GenerationUsage,
  type ImageProviderAdapter,
  type ModelDescriptor,
} from "@/providers/types";
import { ValidationError } from "@/providers/errors";
import { validateAgainstCapabilities } from "@/providers/validate";

export interface GenerationImageSummary {
  idx: number;
  filePath: string;
  thumbPath?: string;
  width?: number;
  height?: number;
  mimeType: string;
}

/** `costUsd` / `costSource` come from CostDecision — always set as a pair. */
export interface GenerationSummary extends CostDecision {
  generationId: string;
  status: GenerationStatus;
  providerId: GenerateRequest["providerId"];
  modelId: string;
  mode: GenerateRequest["mode"];
  images: GenerationImageSummary[];
  usage: GenerationUsage;
  timingMs?: number;
  /** Fan-out shots that failed while siblings succeeded (partial success). */
  imagesFailed?: number;
  /** Set on partial success: "partial_failure:<code of the first failed shot>". */
  errorCode?: string;
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

/**
 * Merge concurrent single-image results into one logical Generation: tokens sum,
 * timing is the wall-clock of the slowest shot (they ran in parallel). Cost is
 * not merged — it's priced once from the summed usage, which also rounds once
 * instead of once per shot.
 */
function mergeResults(parts: GenerateResult[]): GenerateResult {
  const usage: GenerationUsage = {};
  let timingMs = 0;

  for (const part of parts) {
    timingMs = Math.max(timingMs, part.timingMs);
    for (const key of USAGE_KEYS) {
      const value = part.usage[key];
      if (value !== undefined) usage[key] = (usage[key] ?? 0) + value;
    }
  }

  return { images: parts.flatMap((p) => p.images), usage, timingMs };
}

interface GenerateOutcome {
  result: GenerateResult;
  /** Fan-out shots that failed while at least one sibling succeeded. */
  failedShots: number;
  /** First failed shot's error (partial failure only). */
  shotError?: unknown;
}

/**
 * Run the provider call, satisfying `n`: native batch (OpenAI `n`) in one call,
 * or client-side concurrency (Gemini) firing N single-image calls (SPEC §3).
 *
 * Fan-out shots may fail independently. Successful siblings have already been
 * billed, so they are always kept and reported via `failedShots` — this only
 * throws when every shot fails.
 */
async function generateImages(
  adapter: ImageProviderAdapter,
  model: ModelDescriptor,
  req: GenerateRequest,
  n: number,
): Promise<GenerateOutcome> {
  if (model.capabilities.supportsN) {
    return { result: await adapter.generate({ ...req, n }), failedShots: 0 };
  }
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(n, MAX_FANOUT_N) }, () => adapter.generate({ ...req, n: 1 })),
  );
  const ok: GenerateResult[] = [];
  const failed: unknown[] = [];
  for (const shot of settled) {
    if (shot.status === "fulfilled") ok.push(shot.value);
    else failed.push(shot.reason);
  }
  if (ok.length === 0) throw failed[0];
  return {
    result: ok.length === 1 ? ok[0]! : mergeResults(ok),
    failedShots: failed.length,
    shotError: failed[0],
  };
}

export async function runGeneration(
  req: GenerateRequest,
  opts: RunGenerationOptions = {},
): Promise<GenerationSummary> {
  const adapter = resolveAdapter(req, opts);
  const model: ModelDescriptor | undefined = adapter.listModels().find((m) => m.id === req.modelId);
  if (!model) {
    throw new ValidationError(`Unknown model '${req.modelId}'`, [
      { path: "modelId", code: "unknown_model", message: req.modelId },
    ]);
  }

  // The one capability check on the write path — the adapters don't repeat it.
  const check = validateAgainstCapabilities(model, req);
  if (!check.ok) {
    throw new ValidationError("Request failed capability validation", check.issues, {
      providerId: req.providerId,
    });
  }

  const generationId = crypto.randomUUID();
  const n = Math.max(1, req.n ?? 1);
  const estimate = estimateCostUSD(model, req);
  // No usage yet, so the pending row carries the pre-flight "≈$" figure.
  const pendingCost = resolveCost(model, {}, estimate);

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
      ...pendingCost,
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

  const startedAt = Date.now();
  try {
    const { result, failedShots, shotError } = await generateImages(adapter, model, req, n);

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
    // The one place a Generation's dollars are decided (SPEC §6): returned usage
    // wins, the pre-flight estimate on the pending row is the fallback.
    const cost = resolveCost(model, result.usage, estimate);

    // Partial fan-out failure: siblings were billed, so the Generation stays a
    // success; the failed shot's code rides along in error_code for History.
    const partialCode =
      failedShots > 0
        ? `partial_failure:${shotError instanceof ImageProviderError ? shotError.code : "provider"}`
        : undefined;

    db.transaction((tx) => {
      if (imageSummaries.length) {
        tx.insert(generationImages)
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
      tx.update(generations)
        .set({
          status: "success",
          errorCode: partialCode,
          timingMs: result.timingMs,
          textInputTokens: result.usage.textInputTokens,
          imageInputTokens: result.usage.imageInputTokens,
          imageOutputTokens: result.usage.imageOutputTokens,
          costUsd: cost.costUsd,
          costSource: cost.costSource,
        })
        .where(eq(generations.id, generationId))
        .run();
    });

    return {
      generationId,
      status: "success",
      providerId: req.providerId,
      modelId: req.modelId,
      mode: req.mode,
      images: imageSummaries,
      usage: result.usage,
      ...cost,
      timingMs: result.timingMs,
      imagesFailed: failedShots > 0 ? failedShots : undefined,
      errorCode: partialCode,
    };
  } catch (err) {
    const errorCode = err instanceof ImageProviderError ? err.code : "provider";
    db.update(generations)
      .set({ status: "error", errorCode, timingMs: Date.now() - startedAt })
      .where(eq(generations.id, generationId))
      .run();
    throw err;
  }
}
