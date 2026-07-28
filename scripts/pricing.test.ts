/**
 * Cost math (SPEC §6) — the pre-flight estimate, the actual-from-usage figure,
 * and the decision between them.
 *
 * Pure functions over the real `ModelDescriptor` registry: no db, no network.
 * The linearity test is the one that matters architecturally — it's why fan-out
 * can be priced once from the summed usage instead of once per shot (which is
 * what the adapters used to do, only to have the orchestrator discard it).
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { GOOGLE_MODELS } from "@/providers/google/models";
import { OPENAI_MODELS } from "@/providers/openai/models";
import { estimateCostUSD, resolveCost } from "@/providers/pricing";
import type { GenerateRequest, GenerationUsage, ModelDescriptor } from "@/providers/types";

function model(pool: ModelDescriptor[], id: string): ModelDescriptor {
  const found = pool.find((m) => m.id === id);
  assert.ok(found, `${id} metadata present`);
  return found;
}

const GPT2 = model(OPENAI_MODELS, "gpt-image-2");
const PRO = model(GOOGLE_MODELS, "gemini-3-pro-image-preview");

function pixelReq(over: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    providerId: "openai",
    modelId: GPT2.id,
    mode: "t2i",
    prompt: "x",
    sizeSpec: { kind: "pixels", width: 1024, height: 1024 },
    ...over,
  };
}

function ratioReq(over: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    providerId: "google",
    modelId: PRO.id,
    mode: "t2i",
    prompt: "x",
    sizeSpec: { kind: "ratio", aspectRatio: "1:1", imageSize: "2K" },
    ...over,
  };
}

describe("estimateCostUSD", () => {
  test("prices from the per-image table, times n", () => {
    assert.equal(
      estimateCostUSD(GPT2, pixelReq({ quality: "high" })),
      0.125,
      "1024² high, single image",
    );
    assert.equal(
      estimateCostUSD(GPT2, pixelReq({ quality: "high", n: 2 })),
      0.25,
      "1024² high × 2",
    );
  });

  test("an unset or auto quality is priced at the upper bound, so ≈$ never under-quotes", () => {
    const high = estimateCostUSD(GPT2, pixelReq({ quality: "high" }));
    assert.equal(estimateCostUSD(GPT2, pixelReq()), high, "unset → high");
    assert.equal(estimateCostUSD(GPT2, pixelReq({ quality: "auto" })), high, "auto → high");
    assert.ok(estimateCostUSD(GPT2, pixelReq({ quality: "low" }))! < high!);
  });

  test("falls back to the 1024² token basis when there is no table entry", () => {
    // Same model minus its table — the branch real models never reach today.
    const noTable: ModelDescriptor = { ...GPT2, pricing: { ...GPT2.pricing, perImageTable: undefined } };
    // 4160 tok × $30/1M = $0.1248 → $0.125, the table figure it was derived from.
    assert.equal(estimateCostUSD(noTable, pixelReq({ quality: "high" })), 0.125);
    assert.equal(
      estimateCostUSD(noTable, pixelReq({ quality: "high", sizeSpec: { kind: "pixels", width: 1024, height: 1536 } })),
      undefined,
      "the token basis only covers 1024²",
    );
  });

  test("an arbitrary resolution is not statically priceable", () => {
    assert.equal(
      estimateCostUSD(GPT2, pixelReq({ sizeSpec: { kind: "pixels", width: 2048, height: 1152 } })),
      undefined,
      "gpt-image-2 free-form size → needs the returned usage",
    );
  });

  test("prices Gemini by size tier, times n", () => {
    assert.equal(estimateCostUSD(PRO, ratioReq()), 0.134, "2K tier");
    assert.equal(estimateCostUSD(PRO, ratioReq({ n: 3 })), 0.402, "2K × 3");
    assert.equal(
      estimateCostUSD(PRO, ratioReq({ sizeSpec: { kind: "ratio", aspectRatio: "1:1", imageSize: "0.5K" } })),
      undefined,
      "3-pro publishes no 0.5K figure",
    );
  });
});

describe("resolveCost", () => {
  test("returned usage wins and is marked actual", () => {
    // 300 image-output tok × $120/1M — the fan-out figure the smoke test sees.
    assert.deepEqual(resolveCost(PRO, { imageOutputTokens: 300 }, 0.402), {
      costUsd: 0.036,
      costSource: "actual",
    });
  });

  test("bills input tokens too", () => {
    // (100×120 + 1000×2 + 500×2) / 1M
    assert.equal(
      resolveCost(PRO, { imageOutputTokens: 100, textInputTokens: 1000, imageInputTokens: 500 }, undefined)
        .costUsd,
      0.015,
    );
  });

  test("the pre-flight estimate stands when the provider returned no output tokens", () => {
    assert.deepEqual(resolveCost(PRO, {}, 0.134), { costUsd: 0.134, costSource: "estimated" });
    assert.deepEqual(
      resolveCost(PRO, { textInputTokens: 50 }, 0.134),
      { costUsd: 0.134, costSource: "estimated" },
      "input tokens alone are not a billable image",
    );
  });

  test("no figure at all when neither is available", () => {
    assert.deepEqual(resolveCost(GPT2, {}, undefined), {});
  });

  test("figure and source are always set as a pair", () => {
    const usages: GenerationUsage[] = [{}, { textInputTokens: 9 }, { imageOutputTokens: 4160 }];
    for (const usage of usages) {
      for (const estimate of [undefined, 0.125]) {
        const { costUsd, costSource } = resolveCost(GPT2, usage, estimate);
        assert.equal(
          costUsd === undefined,
          costSource === undefined,
          `cost_usd and cost_source disagree for ${JSON.stringify({ usage, estimate })}`,
        );
      }
    }
  });

  test("pricing summed usage once equals pricing each fan-out shot", () => {
    const shot: GenerationUsage = { imageOutputTokens: 1120, textInputTokens: 37, imageInputTokens: 258 };
    const shots = 5;
    const merged: GenerationUsage = {
      imageOutputTokens: shot.imageOutputTokens! * shots,
      textInputTokens: shot.textInputTokens! * shots,
      imageInputTokens: shot.imageInputTokens! * shots,
    };

    const perShot = resolveCost(PRO, shot, undefined).costUsd!;
    const once = resolveCost(PRO, merged, undefined).costUsd!;

    assert.ok(
      Math.abs(once - perShot * shots) <= 0.001,
      `summing rounded shots (${perShot * shots}) must match one rounding of the total (${once})`,
    );
  });

  test("gpt-image-2's derived table agrees with the actual it stands in for", () => {
    // api-facts §4d: the per-image figures are derived from the 1024² token
    // tiers, so the ≈$ shown before the call should survive contact with usage.
    const estimate = estimateCostUSD(GPT2, pixelReq({ quality: "high" }));
    const actual = resolveCost(GPT2, { imageOutputTokens: 4160 }, estimate);
    assert.equal(actual.costSource, "actual");
    assert.equal(actual.costUsd, estimate, "4160 tok × $30/1M == the derived $0.125");
  });
});
