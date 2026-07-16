/**
 * End-to-end smoke test WITHOUT a network call. Injects fake adapters and drives
 * the real orchestration + persistence path (validate → insert → generate →
 * write image + thumbnail → record usage & cost), then reads back from SQLite.
 *
 * Two scenarios:
 *   1. OpenAI-style native batch (supportsN, n=1) → one image.
 *   2. Gemini-style fan-out (supportsN=false, n=3) → 3 concurrent single-image
 *      calls merged into one Generation with summed usage/cost.
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
    validate: () => ({ ok: true }),
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

async function main(): Promise<void> {
  const png = await makePngBase64();
  await scenarioOpenAINative(png);
  await scenarioGeminiFanout(png);
  console.log("\n✓ end-to-end smoke passed (native batch + fan-out)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ smoke failed:", err);
    process.exit(1);
  });
