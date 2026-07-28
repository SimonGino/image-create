/**
 * End-to-end smoke test WITHOUT a network call. Injects fake adapters and drives
 * the real orchestration + persistence path (validate → insert → generate →
 * write image + thumbnail → record usage & cost), then reads back from SQLite.
 *
 * Five scenarios:
 *   1. OpenAI-style native batch (supportsN, n=1) → one image.
 *   2. Gemini-style fan-out (supportsN=false, n=3) → 3 concurrent single-image
 *      calls merged into one Generation with summed usage/cost.
 *   3. Partial fan-out failure → billed siblings persisted, status stays
 *      success, error_code records "partial_failure:<code>".
 *   4. All shots fail → Generation is error with the shot's code and timing.
 *   5. Provider returns no usage → the pre-flight estimate is what gets
 *      recorded, marked cost_source='estimated'.
 *
 * Run: npm run smoke   (after `npm run db:generate`)
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";

import { eq } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db";
import { generationImages, generations } from "@/db/schema";
import { absFromRoot } from "@/lib/paths";
import { ProviderError, RateLimitError } from "@/providers/errors";
import { GOOGLE_MODELS } from "@/providers/google/models";
import { OPENAI_MODELS } from "@/providers/openai/models";
import type {
  GenerateRequest,
  GenerateResult,
  ImageProviderAdapter,
  ModelDescriptor,
} from "@/providers/types";
import { runGeneration } from "@/services/generation";

async function makePngBase64(): Promise<string> {
  const buffer = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
  return buffer.toString("base64");
}

/** A fake adapter that always returns one PNG with the given usage. */
function fakeAdapter(
  model: ModelDescriptor,
  png: string,
  usage: GenerateResult["usage"],
): ImageProviderAdapter {
  return {
    providerId: model.providerId,
    listModels: () => [model],
    async generate(): Promise<GenerateResult> {
      return {
        images: [{ data: png, mimeType: "image/png", width: 512, height: 512 }],
        usage,
        timingMs: 7,
      };
    },
  };
}

async function scenarioOpenAINative(png: string): Promise<void> {
  const model = OPENAI_MODELS.find((m) => m.id === "gpt-image-2");
  assert.ok(model, "gpt-image-2 metadata present");

  const req: GenerateRequest = {
    providerId: "openai",
    modelId: "gpt-image-2",
    mode: "t2i",
    prompt: "a smoke-test swatch",
    sizeSpec: { kind: "pixels", width: 1024, height: 1024 },
    n: 1,
    quality: "high",
    outputFormat: "png",
  };

  const summary = await runGeneration(req, {
    adapter: fakeAdapter(model, png, { textInputTokens: 12, imageOutputTokens: 4160 }),
  });

  assert.equal(summary.status, "success");
  assert.equal(summary.images.length, 1, "one image");
  assert.equal(summary.costSource, "actual");
  assert.ok(summary.costUsd && summary.costUsd > 0, "actual cost computed");

  const img = summary.images[0]!;
  assert.ok(fs.existsSync(absFromRoot(img.filePath)), "original written");
  assert.ok(img.thumbPath && fs.existsSync(absFromRoot(img.thumbPath)), "thumbnail written");

  const row = db.select().from(generations).where(eq(generations.id, summary.generationId)).get();
  assert.ok(row, "generation row persisted");
  assert.equal(row.imageOutputTokens, 4160, "usage tokens stored");
  assert.equal(row.sizeSpec.kind, "pixels", "JSON size_spec round-trips");

  console.log(`  1) openai native   → 1 img  cost=$${summary.costUsd}  gen=${summary.generationId}`);
}

async function scenarioGeminiFanout(png: string): Promise<void> {
  const model = GOOGLE_MODELS.find((m) => m.id === "gemini-3-pro-image-preview");
  assert.ok(model, "gemini-3-pro-image metadata present");
  assert.equal(model.capabilities.supportsN, false, "Gemini has no native n");

  const req: GenerateRequest = {
    providerId: "google",
    modelId: "gemini-3-pro-image-preview",
    mode: "t2i",
    prompt: "three smoke-test swatches",
    sizeSpec: { kind: "ratio", aspectRatio: "16:9", imageSize: "2K" },
    n: 3,
  };

  const summary = await runGeneration(req, {
    adapter: fakeAdapter(model, png, { imageOutputTokens: 100 }),
  });

  // Fan-out: 3 concurrent single-image calls merged into one Generation.
  assert.equal(summary.images.length, 3, "fan-out produced 3 images");
  assert.equal(summary.usage.imageOutputTokens, 300, "usage summed across shots (3×100)");
  assert.equal(summary.costUsd, 0.036, "cost summed (300 tok × $120/1M)");

  for (const img of summary.images) {
    assert.ok(fs.existsSync(absFromRoot(img.filePath)), `image ${img.idx} written`);
  }

  const row = db.select().from(generations).where(eq(generations.id, summary.generationId)).get();
  assert.ok(row, "generation row persisted");
  assert.equal(row.nRequested, 3, "n_requested stored");
  assert.equal(row.sizeSpec.kind, "ratio", "JSON size_spec round-trips to ratio union");

  const imgRows = db
    .select()
    .from(generationImages)
    .where(eq(generationImages.generationId, summary.generationId))
    .all();
  assert.equal(imgRows.length, 3, "3 generation_images rows");

  console.log(`  2) gemini fan-out  → 3 img  cost=$${summary.costUsd}  gen=${summary.generationId}`);
}

async function scenarioPartialFanout(png: string): Promise<void> {
  const model = GOOGLE_MODELS.find((m) => m.id === "gemini-3-pro-image-preview");
  assert.ok(model, "gemini-3-pro-image metadata present");

  let calls = 0;
  const adapter: ImageProviderAdapter = {
    providerId: model.providerId,
    listModels: () => [model],
    async generate(): Promise<GenerateResult> {
      if (calls++ === 1) throw new ProviderError("shot 2 exploded");
      return {
        images: [{ data: png, mimeType: "image/png", width: 512, height: 512 }],
        usage: { imageOutputTokens: 100 },
        timingMs: 7,
      };
    },
  };

  const req: GenerateRequest = {
    providerId: "google",
    modelId: "gemini-3-pro-image-preview",
    mode: "t2i",
    prompt: "partial fan-out",
    sizeSpec: { kind: "ratio", aspectRatio: "1:1", imageSize: "1K" },
    n: 3,
  };

  const summary = await runGeneration(req, { adapter });

  // Billed siblings survive; the failure is recorded, not thrown.
  assert.equal(summary.status, "success");
  assert.equal(summary.images.length, 2, "2 of 3 shots kept");
  assert.equal(summary.imagesFailed, 1, "failed shot count reported");
  assert.equal(summary.errorCode, "partial_failure:provider");
  assert.equal(summary.usage.imageOutputTokens, 200, "usage summed over surviving shots");

  for (const img of summary.images) {
    assert.ok(fs.existsSync(absFromRoot(img.filePath)), `surviving image ${img.idx} written`);
  }

  const row = db.select().from(generations).where(eq(generations.id, summary.generationId)).get();
  assert.ok(row, "generation row persisted");
  assert.equal(row.status, "success", "partial failure still counts as success");
  assert.equal(row.errorCode, "partial_failure:provider", "shot failure recorded");

  const imgRows = db
    .select()
    .from(generationImages)
    .where(eq(generationImages.generationId, summary.generationId))
    .all();
  assert.equal(imgRows.length, 2, "billed siblings persisted");

  console.log(`  3) partial fan-out → 2/3 img kept, error_code=${row.errorCode}`);
}

async function scenarioAllShotsFail(): Promise<void> {
  const model = GOOGLE_MODELS.find((m) => m.id === "gemini-3-pro-image-preview");
  assert.ok(model, "gemini-3-pro-image metadata present");

  const adapter: ImageProviderAdapter = {
    providerId: model.providerId,
    listModels: () => [model],
    async generate(): Promise<GenerateResult> {
      throw new RateLimitError("quota exhausted");
    },
  };

  const prompt = `all shots fail ${Date.now()}`;
  const req: GenerateRequest = {
    providerId: "google",
    modelId: "gemini-3-pro-image-preview",
    mode: "t2i",
    prompt,
    sizeSpec: { kind: "ratio", aspectRatio: "1:1", imageSize: "1K" },
    n: 2,
  };

  await assert.rejects(runGeneration(req, { adapter }), RateLimitError);

  const row = db.select().from(generations).where(eq(generations.prompt, prompt)).get();
  assert.ok(row, "generation row persisted");
  assert.equal(row.status, "error");
  assert.equal(row.errorCode, "rate_limit", "first shot's code recorded");
  assert.ok(row.timingMs !== null, "error branch records timing");

  console.log(`  4) all shots fail  → status=error code=${row.errorCode} timing=${row.timingMs}ms`);
}

async function scenarioNoUsageReturned(png: string): Promise<void> {
  const model = GOOGLE_MODELS.find((m) => m.id === "gemini-3-pro-image-preview");
  assert.ok(model, "gemini-3-pro-image metadata present");

  const prompt = `no usage metadata ${Date.now()}`;
  const req: GenerateRequest = {
    providerId: "google",
    modelId: "gemini-3-pro-image-preview",
    mode: "t2i",
    prompt,
    sizeSpec: { kind: "ratio", aspectRatio: "1:1", imageSize: "2K" },
    n: 1,
  };

  // Relays and proxies sometimes drop usageMetadata: the pre-flight estimate has
  // to survive as the recorded cost, marked 'estimated' (SPEC §6).
  const summary = await runGeneration(req, { adapter: fakeAdapter(model, png, {}) });

  assert.equal(summary.status, "success");
  assert.equal(summary.costUsd, 0.134, "2K tier estimate kept");
  assert.equal(summary.costSource, "estimated", "and reported as an estimate, not as actual");

  const row = db.select().from(generations).where(eq(generations.prompt, prompt)).get();
  assert.ok(row, "generation row persisted");
  assert.equal(row.costUsd, 0.134, "the estimate is what the row still carries");
  assert.equal(row.costSource, "estimated");
  assert.equal(row.imageOutputTokens, null, "no usage to store");

  console.log(`  5) no usage        → cost=$${row.costUsd} source=${row.costSource}`);
}

async function main(): Promise<void> {
  const png = await makePngBase64();
  await scenarioOpenAINative(png);
  await scenarioGeminiFanout(png);
  await scenarioPartialFanout(png);
  await scenarioAllShotsFail();
  await scenarioNoUsageReturned(png);
  console.log("\n✓ end-to-end smoke passed (native batch + fan-out + partial failure + cost fallback)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ smoke failed:", err);
    process.exit(1);
  });
