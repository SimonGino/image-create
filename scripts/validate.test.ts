/**
 * Capability validation (SPEC §3) — one interpreter, every provider.
 *
 * The point of these tests is that the rules are now *provider-independent*:
 * the same malformed request produces the same issue code whichever provider it
 * names, and rules that used to live in only one adapter (ParamSchema checking)
 * now apply to both.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { defaultRequestFor } from "@/providers/request";
import { listAllModels } from "@/providers/registry";
import { MAX_FANOUT_N, type GenerateRequest, type ModelDescriptor } from "@/providers/types";
import { validateAgainstCapabilities } from "@/providers/validate";

const MODELS = listAllModels();

function byId(id: string): ModelDescriptor {
  const found = MODELS.find((m) => m.id === id);
  assert.ok(found, `${id} is registered`);
  return found;
}

const GPT2 = byId("gpt-image-2");
const PRO = byId("gemini-3-pro-image-preview");

/** The issue codes a request produces, keyed by path — the whole verdict. */
function issues(model: ModelDescriptor, req: GenerateRequest): Record<string, string> {
  const result = validateAgainstCapabilities(model, req);
  if (result.ok) return {};
  return Object.fromEntries(result.issues.map((i) => [i.path ?? "", i.code]));
}

const okPixels = (over: Partial<GenerateRequest> = {}) =>
  defaultRequestFor(GPT2, { prompt: "x", ...over });
const okRatio = (over: Partial<GenerateRequest> = {}) =>
  defaultRequestFor(PRO, { prompt: "x", ...over });

describe("the seven shared rules", () => {
  test("a default request is accepted", () => {
    assert.deepEqual(validateAgainstCapabilities(GPT2, okPixels()), { ok: true });
    assert.deepEqual(validateAgainstCapabilities(PRO, okRatio()), { ok: true });
  });

  test("prompt is required", () => {
    assert.deepEqual(issues(GPT2, okPixels({ prompt: "" })), { prompt: "required" });
    assert.deepEqual(issues(GPT2, okPixels({ prompt: "   " })), { prompt: "required" }, "whitespace is empty");
  });

  test("mode must be one the model declares", () => {
    const textOnly: ModelDescriptor = {
      ...GPT2,
      capabilities: { ...GPT2.capabilities, modes: ["t2i"] },
    };
    assert.deepEqual(issues(textOnly, { ...okPixels(), mode: "reference" }).mode, "unsupported_mode");
  });

  test("the size arm has to match how the model thinks about size", () => {
    assert.equal(issues(PRO, { ...okRatio(), sizeSpec: { kind: "pixels", width: 1024, height: 1024 } }).sizeSpec, "wrong_size_kind");
    assert.equal(issues(GPT2, { ...okPixels(), sizeSpec: { kind: "ratio", aspectRatio: "1:1", imageSize: "1K" } }).sizeSpec, "wrong_size_kind");
  });

  test("a presets-only model rejects an off-list size; a free-form one checks bounds", () => {
    const odd = { kind: "pixels", width: 2048, height: 1152 } as const;
    // The only pixel model we ship takes any resolution within bounds, so the
    // whitelist branch needs a model that declares none.
    const presetsOnly: ModelDescriptor = {
      ...GPT2,
      capabilities: { ...GPT2.capabilities, pixelBounds: undefined },
    };
    assert.equal(issues(presetsOnly, { ...okPixels(), sizeSpec: odd }).sizeSpec, "unsupported_size");
    assert.deepEqual(issues(GPT2, { ...okPixels(), sizeSpec: odd }), {}, "gpt-image-2 allows it");

    const bounds = GPT2.capabilities.pixelBounds;
    assert.ok(bounds);
    assert.equal(
      issues(GPT2, { ...okPixels(), sizeSpec: { kind: "pixels", width: bounds.max + 1, height: 1024 } }).sizeSpec,
      "out_of_bounds",
    );
  });

  test("ratio and tier are checked separately", () => {
    // Every shipped ratio model publishes 4K, so the tier rule needs a narrower one.
    const oneTier: ModelDescriptor = {
      ...PRO,
      capabilities: { ...PRO.capabilities, imageSizeTiers: ["1K"] },
    };
    const at4K = { ...okRatio(), sizeSpec: { kind: "ratio", aspectRatio: "16:9", imageSize: "4K" } } as const;
    assert.deepEqual(issues(PRO, at4K), {}, "3-pro publishes 4K");
    assert.equal(issues(oneTier, at4K)["sizeSpec.imageSize"], "unsupported_size", "1K-only rejects it");
  });

  test("n is bounded by what the app can deliver, not by the provider's native n", () => {
    assert.equal(PRO.capabilities.maxN, 1, "premise: Gemini returns one image per call");
    assert.deepEqual(issues(PRO, { ...okRatio(), n: MAX_FANOUT_N }), {}, "fan-out covers it");
    assert.equal(issues(PRO, { ...okRatio(), n: MAX_FANOUT_N + 1 }).n, "max");
    assert.equal(issues(GPT2, { ...okPixels(), n: 0 }).n, "min");
    assert.equal(issues(GPT2, { ...okPixels(), n: 2.5 }).n, "type", "a fractional n is not a count");
    assert.deepEqual(issues(GPT2, { ...okPixels(), n: 10 }), {}, "OpenAI's native batch");
  });

  test("reference inputs: required, counted, and masked only where supported", () => {
    const img = { data: "AAAA", mimeType: "image/png" } as const;
    const mask = { ...img, role: "mask" as const };

    assert.equal(issues(GPT2, { ...okPixels(), mode: "reference" }).refImages, "required");
    assert.deepEqual(issues(GPT2, { ...okPixels(), mode: "reference", refImages: [img] }), {});

    const tooMany = Array.from({ length: GPT2.capabilities.maxRefImages + 1 }, () => img);
    assert.equal(issues(GPT2, { ...okPixels(), mode: "reference", refImages: tooMany }).refImages, "too_many");

    assert.deepEqual(issues(GPT2, { ...okPixels(), mode: "reference", refImages: [img, mask] }), {}, "OpenAI supports a mask");
    assert.equal(PRO.capabilities.supportsMask, false, "premise: Gemini has no mask");
    assert.equal(issues(PRO, { ...okRatio(), mode: "reference", refImages: [img, mask] }).refImages, "no_mask");
    assert.equal(
      issues(GPT2, { ...okPixels(), mode: "reference", refImages: [img, mask, mask] }).refImages,
      "too_many_masks",
    );
  });

  test("reference inputs sent with t2i are rejected, not silently billed", () => {
    // The orchestrator only persists refs in reference mode, but the Gemini
    // adapter would still put them on the wire — they'd shape the image and be
    // charged for, with nothing recorded about them.
    const withRefs = { ...okRatio(), refImages: [{ data: "AAAA", mimeType: "image/png" }] };
    assert.equal(withRefs.mode, "t2i");
    assert.equal(issues(PRO, withRefs).refImages, "unexpected");
  });

  test("output format must be one the model produces", () => {
    assert.equal(PRO.capabilities.outputFormats.join(), "png", "premise: Gemini is png-only");
    assert.equal(issues(PRO, { ...okRatio(), outputFormat: "webp" }).outputFormat, "unsupported_format");
    assert.deepEqual(issues(GPT2, { ...okPixels(), outputFormat: "webp" }), {});
  });

  test("quality is rejected by models that have no quality control", () => {
    // Previously only OpenAI checked this, so a quality asked of Gemini was
    // accepted and then quietly dropped on the way to the provider.
    assert.equal(PRO.capabilities.qualities, undefined, "premise: no quality metadata");
    assert.equal(issues(PRO, { ...okRatio(), quality: "high" }).quality, "unsupported_quality");
    assert.deepEqual(issues(GPT2, { ...okPixels(), quality: "low" }), {});
  });
});

describe("provider-private params", () => {
  test("are checked against their declared schema", () => {
    const req = okPixels();
    assert.equal(
      issues(GPT2, { ...req, providerParams: { background: "chartreuse" } })["providerParams.background"],
      "enum",
    );
    assert.equal(
      issues(GPT2, { ...req, providerParams: { output_compression: 500 } })["providerParams.output_compression"],
      "max",
    );
    assert.equal(
      issues(GPT2, { ...req, providerParams: { output_compression: "80" } })["providerParams.output_compression"],
      "type",
    );
    assert.deepEqual(issues(GPT2, { ...req, providerParams: { background: "transparent", output_compression: 80 } }), {});
  });

  test("unknown keys stay allowed — the documented escape hatch", () => {
    assert.deepEqual(
      issues(GPT2, { ...okPixels(), providerParams: { some_new_flag: 1 } }),
      {},
    );
  });

  test("the check now reaches every provider, not just the one that had it", () => {
    // Gemini declares no extraParams, so anything it is handed is an unknown
    // key — but the *rule* runs for it now, which is what changed.
    assert.equal(PRO.capabilities.extraParams, undefined);
    assert.deepEqual(issues(PRO, { ...okRatio(), providerParams: { whatever: true } }), {});

    // Give a Gemini model a schema and the same interpreter enforces it.
    const withSchema: ModelDescriptor = {
      ...PRO,
      capabilities: {
        ...PRO.capabilities,
        extraParams: [{ key: "seed", label: "Seed", type: "number", min: 0, max: 100 }],
      },
    };
    assert.equal(issues(withSchema, { ...okRatio(), providerParams: { seed: 999 } })["providerParams.seed"], "max");
  });
});

describe("the interpreter is provider-independent", () => {
  test("the same mistake yields the same code whichever provider is named", () => {
    for (const model of MODELS) {
      const base = defaultRequestFor(model, { prompt: "x" });
      assert.equal(issues(model, { ...base, prompt: "" }).prompt, "required", `${model.id} prompt`);
      assert.equal(issues(model, { ...base, n: 0 }).n, "min", `${model.id} n`);
      assert.equal(issues(model, { ...base, n: 99 }).n, "max", `${model.id} n ceiling`);
      assert.equal(
        issues(model, { ...base, mode: "reference", refImages: [] }).refImages,
        "required",
        `${model.id} refs`,
      );
    }
  });

  test("every issue is collected, not just the first", () => {
    const result = validateAgainstCapabilities(PRO, {
      ...okRatio(),
      prompt: "",
      n: 99,
      outputFormat: "jpeg",
      quality: "high",
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.ok ? [] : result.issues.map((i) => i.path).sort(),
      ["n", "outputFormat", "prompt", "quality"],
      "the console shows the whole list at once",
    );
  });
});
