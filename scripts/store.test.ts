/**
 * Read-path tests: the queries behind Gallery, History and the usage chip
 * (SPEC §6, §7) — filters, pagination, totals, aggregation, cascade delete,
 * and Prompt Template CRUD.
 *
 * Runs against a real SQLite file in a throwaway DATA_DIR (see `npm run test`),
 * because better-sqlite3 is the only db adapter there will ever be — the seam
 * that varies is which file it opens, not which driver. Real SQL, real JSON
 * column round-trips.
 *
 * Rows are inserted directly here: these tests are about how the store *reads*,
 * so the setup needs control over createdAt / status / cost that the write path
 * deliberately owns. The write path's own end-to-end test is scripts/smoke.ts.
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";
import { before, describe, test } from "node:test";

import { db } from "@/db";
import { generationImages, generationRefImages, generations } from "@/db/schema";
import {
  deleteGeneration,
  distinctModelIds,
  getGeneration,
  listGenerations,
  usageSummary,
} from "@/lib/generation-store";
import { generationImageDir } from "@/lib/paths";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
} from "@/lib/template-store";
import type { SizeSpec } from "@/providers/types";

const PIXELS: SizeSpec = { kind: "pixels", width: 1024, height: 1024 };
const RATIO: SizeSpec = { kind: "ratio", aspectRatio: "16:9", imageSize: "2K" };

/** 2026-03-15 and 2026-04-02 — two calendar months for the byMonth bucketing. */
const MARCH = new Date("2026-03-15T10:00:00Z");
const APRIL = new Date("2026-04-02T10:00:00Z");

interface SeedRow {
  id: string;
  createdAt: Date;
  providerId: "openai" | "google";
  modelId: string;
  mode: "t2i" | "reference";
  sizeSpec: SizeSpec;
  nRequested: number;
  status: "success" | "error" | "pending";
  errorCode?: string;
  costUsd?: number;
  timingMs?: number;
  images: number;
}

const SEED: SeedRow[] = [
  // Oldest first; listGenerations must return them newest-first.
  { id: "g1", createdAt: MARCH, providerId: "openai", modelId: "gpt-image-2", mode: "t2i",
    sizeSpec: PIXELS, nRequested: 1, status: "success", costUsd: 0.125, timingMs: 4000, images: 1 },
  { id: "g2", createdAt: MARCH, providerId: "google", modelId: "gemini-3-pro-image-preview",
    mode: "t2i", sizeSpec: RATIO, nRequested: 3, status: "success", costUsd: 0.036, timingMs: 9000, images: 3 },
  { id: "g3", createdAt: APRIL, providerId: "google", modelId: "gemini-3-pro-image-preview",
    mode: "reference", sizeSpec: RATIO, nRequested: 1, status: "error", errorCode: "rate_limit",
    timingMs: 500, images: 0 },
  // Partial failure: billed siblings kept, so it counts as a success with a code.
  { id: "g4", createdAt: APRIL, providerId: "google", modelId: "gemini-3.1-flash-image-preview",
    mode: "t2i", sizeSpec: RATIO, nRequested: 3, status: "success",
    errorCode: "partial_failure:provider", costUsd: 0.024, timingMs: 7000, images: 2 },
  { id: "g5", createdAt: APRIL, providerId: "openai", modelId: "gpt-image-2", mode: "t2i",
    sizeSpec: PIXELS, nRequested: 1, status: "pending", images: 0 },
];

function seed(): void {
  for (const row of SEED) {
    db.insert(generations)
      .values({
        id: row.id,
        createdAt: row.createdAt,
        providerId: row.providerId,
        modelId: row.modelId,
        mode: row.mode,
        prompt: `prompt for ${row.id}`,
        sizeSpec: row.sizeSpec,
        nRequested: row.nRequested,
        status: row.status,
        errorCode: row.errorCode,
        costUsd: row.costUsd,
        costSource: row.costUsd !== undefined ? "actual" : undefined,
        timingMs: row.timingMs,
        imageOutputTokens: row.costUsd !== undefined ? 100 : undefined,
      })
      .run();

    for (let i = 0; i < row.images; i++) {
      db.insert(generationImages)
        .values({
          generationId: row.id,
          idx: i,
          filePath: `.test-data/images/${row.id}/${i}.png`,
          thumbPath: `.test-data/images/${row.id}/${i}.thumb.webp`,
          width: 1024,
          height: 1024,
          mimeType: "image/png",
        })
        .run();
    }
  }

  // g3 is a reference-mode Generation — give it a ref input for the detail test.
  db.insert(generationRefImages)
    .values({ generationId: "g3", idx: 0, filePath: ".test-data/images/g3/refs/0.png", role: "image" })
    .run();
}

before(() => {
  assert.equal(
    db.select().from(generations).all().length,
    0,
    "tests need a fresh DATA_DIR — run via `npm run test`",
  );
  seed();
});

describe("listGenerations", () => {
  test("returns every status, newest-first, with the true total", () => {
    const page = listGenerations();
    assert.equal(page.total, 5, "total counts all statuses");
    assert.equal(page.generations.length, 5);
    assert.deepEqual(
      page.generations.map((g) => g.status),
      ["pending", "success", "error", "success", "success"],
      "newest-first: the April rows precede the March ones",
    );
  });

  test("attaches each Generation's images, ordered by idx", () => {
    const g2 = listGenerations().generations.find((g) => g.id === "g2");
    assert.ok(g2);
    assert.deepEqual(g2.images.map((i) => i.idx), [0, 1, 2], "fan-out images in order");
    assert.equal(g2.nRequested, 3, "nRequested rides along for History");
  });

  test("filters server-side and narrows the total with them", () => {
    const google = listGenerations({ providerId: "google" });
    assert.equal(google.total, 3);
    assert.deepEqual(google.generations.map((g) => g.id).sort(), ["g2", "g3", "g4"]);

    const errors = listGenerations({ status: "error" });
    assert.equal(errors.total, 1);
    assert.equal(errors.generations[0]?.errorCode, "rate_limit");

    const refs = listGenerations({ mode: "reference" });
    assert.equal(refs.total, 1);
    assert.equal(refs.generations[0]?.id, "g3");

    const byModel = listGenerations({ modelId: "gpt-image-2" });
    assert.equal(byModel.total, 2);

    const combined = listGenerations({ providerId: "google", status: "success" });
    assert.equal(combined.total, 2, "filters combine with AND");
    assert.deepEqual(combined.generations.map((g) => g.id).sort(), ["g2", "g4"]);
  });

  test("pages without changing the total, and pages don't overlap", () => {
    const first = listGenerations({ limit: 2, offset: 0 });
    const second = listGenerations({ limit: 2, offset: 2 });
    const third = listGenerations({ limit: 2, offset: 4 });

    assert.equal(first.total, 5, "total is the unpaged count");
    assert.equal(second.total, 5);
    assert.equal(first.generations.length, 2);
    assert.equal(second.generations.length, 2);
    assert.equal(third.generations.length, 1, "last page is partial");

    const ids = [first, second, third].flatMap((p) => p.generations.map((g) => g.id));
    assert.equal(new Set(ids).size, 5, "no row appears on two pages");
  });

  test("an offset past the end is an empty page, not an error", () => {
    const page = listGenerations({ limit: 2, offset: 99 });
    assert.equal(page.generations.length, 0);
    assert.equal(page.total, 5, "total still reports the whole set");
  });
});

describe("distinctModelIds", () => {
  test("covers the whole table, not just one page", () => {
    assert.deepEqual(distinctModelIds(), [
      "gemini-3-pro-image-preview",
      "gemini-3.1-flash-image-preview",
      "gpt-image-2",
    ]);
  });
});

describe("getGeneration", () => {
  test("returns the full detail with nested usage and refs", () => {
    const detail = getGeneration("g3");
    assert.ok(detail);
    assert.equal(detail.status, "error");
    assert.equal(detail.errorCode, "rate_limit");
    assert.equal(detail.sizeSpec.kind, "ratio", "JSON size_spec round-trips to the ratio arm");
    assert.deepEqual(detail.refImages.map((r) => r.idx), [0]);
    assert.equal(detail.usage.imageOutputTokens, undefined, "no usage on a failed Generation");
  });

  test("normalises absent columns to undefined, never null", () => {
    const detail = getGeneration("g5");
    assert.ok(detail);
    const nulls = JSON.stringify(detail).match(/:null/g) ?? [];
    assert.deepEqual(nulls, [], "the wire contract has no nulls");
    assert.equal(detail.costUsd, undefined);
    assert.equal(detail.quality, undefined);
  });

  test("is undefined for an unknown id", () => {
    assert.equal(getGeneration("nope"), undefined);
  });
});

describe("usageSummary", () => {
  test("sums actual cost over successful Generations only", () => {
    const usage = usageSummary();
    // g1 0.125 + g2 0.036 + g4 0.024 — the error and pending rows contribute nothing.
    assert.equal(usage.total.costUsd, 0.185);
    assert.equal(usage.total.count, 3);
  });

  test("counts a partial failure, because that money was really spent", () => {
    const flash = usageSummary().byModel.find(
      (m) => m.modelId === "gemini-3.1-flash-image-preview",
    );
    assert.ok(flash, "the partially-failed Generation still appears");
    assert.equal(flash.costUsd, 0.024);
  });

  test("groups by provider and by calendar month", () => {
    const usage = usageSummary();

    assert.deepEqual(
      usage.byProvider.map((p) => [p.providerId, p.costUsd, p.count]).sort(),
      [
        ["google", 0.06, 2],
        ["openai", 0.125, 1],
      ].sort(),
    );

    assert.deepEqual(
      usage.byMonth.map((m) => [m.month, m.count]),
      [
        ["2026-03", 2],
        ["2026-04", 1],
      ],
      "months are bucketed and ordered ascending",
    );
  });
});

describe("deleteGeneration", () => {
  test("cascades to images and refs, removes the folder, and is idempotent", async () => {
    const dir = generationImageDir("g3");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/0.png`, "x");

    await deleteGeneration("g3");

    assert.equal(getGeneration("g3"), undefined);
    assert.equal(
      db.select().from(generationRefImages).all().filter((r) => r.generationId === "g3").length,
      0,
      "FK cascade dropped the ref rows",
    );
    assert.equal(fs.existsSync(dir), false, "on-disk folder removed");
    assert.equal(listGenerations().total, 4, "total reflects the deletion");

    await deleteGeneration("g3"); // second call must not throw
    await deleteGeneration("never-existed");
  });
});

describe("template-store", () => {
  test("creates, orders favorites first, patches and deletes", () => {
    assert.deepEqual(listTemplates(), []);

    const plain = createTemplate({ title: "plain", body: "a prompt" });
    const starred = createTemplate({
      title: "starred",
      body: "another",
      defaultProviderId: "google",
      defaultModelId: "gemini-3-pro-image-preview",
    });

    assert.equal(plain.favorite, false, "not favorited by default");
    assert.equal(starred.defaultProviderId, "google");
    assert.equal(starred.variables, undefined, "absent column is undefined, not null");
    assert.ok(!Number.isNaN(new Date(starred.createdAt).getTime()), "createdAt is ISO");

    const updated = updateTemplate(starred.id, { favorite: true });
    assert.equal(updated?.favorite, true);

    assert.deepEqual(
      listTemplates().map((t) => t.title),
      ["starred", "plain"],
      "favorites come first",
    );

    assert.equal(updateTemplate("nope", { favorite: true }), undefined, "unknown id → undefined");

    deleteTemplate(plain.id);
    deleteTemplate(plain.id); // idempotent
    assert.deepEqual(listTemplates().map((t) => t.title), ["starred"]);
  });
});
