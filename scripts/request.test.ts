/**
 * Request building (SPEC §3, §7): defaults and clamping derived from
 * `ModelCapabilities`.
 *
 * The load-bearing tests are the two property tests over the whole registry:
 * every default request, and every draft carried from one model to another, has
 * to pass capability validation for the target model. Builder and validator read
 * the same metadata from opposite directions, and this is what keeps them
 * agreeing — the coupling the UI used to reproduce by hand with 21 useState,
 * plus a second set of hardcoded defaults in the compare grid.
 *
 * Pure: no db, no network.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  clampRequest,
  defaultRequestFor,
  effectiveMaxN,
  parsePixelSize,
  pixelSizeKey,
} from "@/providers/request";
import { listAllModels } from "@/providers/registry";
import { MAX_FANOUT_N, type GenerateRequest, type ModelDescriptor } from "@/providers/types";
import { validateAgainstCapabilities } from "@/providers/validate";

const MODELS = listAllModels();

function byId(id: string): ModelDescriptor {
  const found = MODELS.find((m) => m.id === id);
  assert.ok(found, `${id} is registered`);
  return found;
}

/** Assert a request passes capability validation for that model. */
function assertValid(model: ModelDescriptor, req: GenerateRequest, label: string): void {
  const result = validateAgainstCapabilities(model, req);
  assert.ok(
    result.ok,
    `${label}: ${model.id} rejected its own request — ${
      result.ok ? "" : result.issues.map((i) => `${i.path}:${i.code}`).join(", ")
    }`,
  );
}

/** The size tier a model defaults to. */
function tierOf(model: ModelDescriptor): string {
  const { sizeSpec } = defaultRequestFor(model, { prompt: "x" });
  assert.equal(sizeSpec.kind, "ratio", `${model.id} is ratio-based`);
  return sizeSpec.kind === "ratio" ? sizeSpec.imageSize : "";
}

const GPT2 = byId("gpt-image-2");
const PRO = byId("gemini-3-pro-image-preview");
const FLASH = byId("gemini-3.1-flash-image-preview");

/**
 * A single-tier ratio model. Every shipped ratio model publishes several size
 * tiers, so "fall back to a tier the target does publish" needs one that offers
 * exactly one — a premise worth stating rather than borrowing from a model that
 * happens to be 1K-only today.
 */
const ONE_TIER: ModelDescriptor = {
  ...PRO,
  id: "one-tier",
  capabilities: { ...PRO.capabilities, imageSizeTiers: ["1K"] },
};

/**
 * A presets-only pixel model. The one pixel model we ship (gpt-image-2) accepts
 * arbitrary resolutions, so "snap an off-list size to a preset" needs a model
 * that declares no `pixelBounds` — stated here as a premise rather than left to
 * a shipped model happening to lack them.
 */
const PRESETS_ONLY: ModelDescriptor = {
  ...GPT2,
  id: "presets-only",
  capabilities: { ...GPT2.capabilities, pixelBounds: undefined },
};

describe("defaultRequestFor", () => {
  test("every registered model accepts its own default t2i request", () => {
    for (const model of MODELS) {
      assertValid(model, defaultRequestFor(model, { mode: "t2i", prompt: "x" }), "default t2i");
    }
  });

  test("every reference-capable model accepts its own default reference request", () => {
    const ref = { data: "AAAA", mimeType: "image/png" as const };
    for (const model of MODELS.filter((m) => m.capabilities.modes.includes("reference"))) {
      const req = defaultRequestFor(model, { mode: "reference", prompt: "x", refImages: [ref] });
      assert.deepEqual(req.refImages, [ref], "ref inputs pass through untouched");
      assertValid(model, req, "default reference");
    }
  });

  test("defaults come from the capability metadata, not from constants", () => {
    assert.deepEqual(defaultRequestFor(GPT2, { prompt: "x" }).sizeSpec, {
      kind: "pixels",
      width: 1024,
      height: 1024,
    });
    assert.deepEqual(defaultRequestFor(PRO, { prompt: "x" }).sizeSpec, {
      kind: "ratio",
      aspectRatio: "1:1",
      imageSize: "1K",
    });
    // flash offers 0.5K first, but 1K is the tier to land on by default.
    assert.equal(FLASH.capabilities.imageSizeTiers?.[0], "0.5K", "premise: 0.5K is listed first");
    assert.equal(tierOf(FLASH), "1K");
    // a model that publishes one tier gets that tier.
    assert.equal(tierOf(ONE_TIER), "1K");
  });

  test("quality only appears on models that expose it", () => {
    assert.equal(defaultRequestFor(GPT2, { prompt: "x" }).quality, "high");
    assert.equal(PRO.capabilities.qualities, undefined, "premise: Gemini has no quality control");
    assert.ok(!("quality" in defaultRequestFor(PRO, { prompt: "x" })), "key is absent, not undefined");
  });

  test("provider-private params start at their declared defaults", () => {
    assert.deepEqual(defaultRequestFor(GPT2, { prompt: "x" }).providerParams, { background: "auto" });
    assert.equal(defaultRequestFor(PRO, { prompt: "x" }).providerParams, undefined);
  });

  test("an out-of-range override is clamped, not trusted", () => {
    assert.equal(defaultRequestFor(PRO, { prompt: "x", n: 99 }).n, MAX_FANOUT_N);
    assert.equal(defaultRequestFor(GPT2, { prompt: "x", n: 0 }).n, 1);
  });
});

describe("effectiveMaxN", () => {
  test("native batch for OpenAI, the fan-out ceiling for Gemini", () => {
    assert.equal(effectiveMaxN(GPT2), 10, "provider's own maxN");
    assert.equal(effectiveMaxN(PRO), MAX_FANOUT_N, "no native n → app ceiling");
    assert.equal(PRO.capabilities.maxN, 1, "premise: the provider itself only does 1");
  });
});

describe("clampRequest", () => {
  test("keeps every setting the new model still accepts", () => {
    const from: GenerateRequest = {
      ...defaultRequestFor(GPT2, { prompt: "a portrait", n: 4 }),
      sizeSpec: { kind: "pixels", width: 1536, height: 1024 },
      quality: "medium",
      outputFormat: "webp",
    };
    const to = clampRequest(PRESETS_ONLY, from);

    assert.equal(to.modelId, PRESETS_ONLY.id);
    assert.equal(to.prompt, "a portrait", "the prompt is never touched");
    assert.equal(to.n, 4, "n is in range for both");
    assert.equal(to.quality, "medium");
    assert.equal(to.outputFormat, "webp");
    assert.deepEqual(to.sizeSpec, { kind: "pixels", width: 1536, height: 1024 }, "a shared preset survives");
  });

  test("snaps a free-form size back to a preset on a presets-only model", () => {
    const custom = clampRequest(GPT2, {
      ...defaultRequestFor(GPT2, { prompt: "x" }),
      sizeSpec: { kind: "pixels", width: 2048, height: 1152 },
    });
    assert.deepEqual(custom.sizeSpec, { kind: "pixels", width: 2048, height: 1152 }, "gpt-image-2 allows it");

    const snapped = clampRequest(PRESETS_ONLY, custom);
    assert.deepEqual(snapped.sizeSpec, { kind: "pixels", width: 1024, height: 1024 });
    assertValid(PRESETS_ONLY, { ...snapped, prompt: "x" }, "snapped size");
  });

  test("clamps a free-form size into the model's own bounds", () => {
    const bounds = GPT2.capabilities.pixelBounds;
    assert.ok(bounds, "premise: gpt-image-2 declares pixel bounds");
    const clamped = clampRequest(GPT2, {
      ...defaultRequestFor(GPT2, { prompt: "x" }),
      sizeSpec: { kind: "pixels", width: 99, height: 99_999 },
    });
    assert.deepEqual(clamped.sizeSpec, { kind: "pixels", width: bounds.min, height: bounds.max });
  });

  test("swaps the size arm when the new model thinks in ratios", () => {
    const toGemini = clampRequest(PRO, defaultRequestFor(GPT2, { prompt: "x", n: 4 }));
    assert.equal(toGemini.sizeSpec.kind, "ratio");
    assert.ok(!("quality" in toGemini), "Gemini has no quality control, so the key goes away");
    assert.equal(toGemini.n, 4, "4 is within the fan-out ceiling");

    const back = clampRequest(GPT2, toGemini);
    assert.equal(back.sizeSpec.kind, "pixels");
    assert.equal(back.quality, "high", "and comes back at the default");
  });

  test("drops a tier the new model does not publish", () => {
    const at4K = clampRequest(FLASH, {
      ...defaultRequestFor(FLASH, { prompt: "x" }),
      sizeSpec: { kind: "ratio", aspectRatio: "16:9", imageSize: "4K" },
    });
    assert.equal(at4K.sizeSpec.kind === "ratio" && at4K.sizeSpec.imageSize, "4K");

    // The target is 1K-only — the tier has to fall back, the aspect ratio can stay.
    const narrowed = clampRequest(ONE_TIER, at4K);
    assert.deepEqual(narrowed.sizeSpec, { kind: "ratio", aspectRatio: "16:9", imageSize: "1K" });
    assertValid(ONE_TIER, { ...narrowed, prompt: "x" }, "clamped tier");
  });

  test("clamps n down to the new model's ceiling", () => {
    const eight = defaultRequestFor(PRO, { prompt: "x", n: 8 });
    assert.equal(clampRequest(GPT2, eight).n, 8, "10 ≥ 8, so it survives");
    assert.equal(clampRequest(PRO, { ...eight, n: 20 }).n, MAX_FANOUT_N);
    assert.equal(clampRequest(PRO, { ...eight, n: Number.NaN }).n, 1, "a half-typed number is not n=NaN");
  });

  test("carries compatible provider params and defaults the rest", () => {
    const withParams = {
      ...defaultRequestFor(GPT2, { prompt: "x" }),
      providerParams: { background: "transparent", output_compression: 80, stale_key: "从别的 provider 带来的" },
    };
    const kept = clampRequest(PRESETS_ONLY, withParams);
    assert.deepEqual(kept.providerParams, { background: "transparent", output_compression: 80 });

    const wrongEnum = clampRequest(GPT2, {
      ...withParams,
      providerParams: { background: "not-a-real-option" },
    });
    assert.deepEqual(wrongEnum.providerParams, { background: "auto" }, "invalid enum → declared default");

    assert.equal(clampRequest(PRO, withParams).providerParams, undefined, "Gemini declares none");
  });

  test("every model pair produces a request the target accepts", () => {
    for (const from of MODELS) {
      for (const to of MODELS) {
        const mode = to.capabilities.modes.includes("t2i") ? "t2i" : to.capabilities.modes[0]!;
        const draft = defaultRequestFor(from, { mode: "t2i", prompt: "x", n: 3 });
        assertValid(to, { ...clampRequest(to, draft), mode, prompt: "x" }, `${from.id} → ${to.id}`);
      }
    }
  });
});

describe("pixel size codec", () => {
  test("round-trips every declared preset", () => {
    for (const model of MODELS) {
      for (const key of model.capabilities.pixelSizes ?? []) {
        const parsed = parsePixelSize(key);
        assert.ok(parsed, `${key} parses`);
        assert.equal(pixelSizeKey(parsed.width, parsed.height), key);
      }
    }
  });

  test("rejects anything that is not a WxH pair", () => {
    for (const bad of ["", "1024", "1024x", "x1024", "axb", undefined]) {
      assert.equal(parsePixelSize(bad), undefined, `${bad} is not a size`);
    }
  });
});
