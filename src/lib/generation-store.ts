/**
 * Every server-side read of Generations, in the wire shapes the browser
 * consumes (SPEC §6, §7). The single place that turns rows into
 * `WireGenerationRow` / `WireGenerationDetail`, so POST /api/generate, GET
 * /api/generations and GET /api/generations/[id] cannot drift apart.
 *
 * Gallery and History are the same entity read two ways — both go through
 * `listGenerations`, which returns every status, newest-first, with
 * server-side filters, pagination and a total.
 *
 * The db is not injected: better-sqlite3 is the only adapter there will ever
 * be, so the seam that actually varies is which *file* it opens — DATA_DIR.
 * Tests point that at a temp dir (see scripts/*.test.ts).
 *
 * Node-only (better-sqlite3 via @/db) — routes and scripts, never components.
 */

import fs from "node:fs/promises";

import { and, asc, count, desc, eq, inArray, sql, sum } from "drizzle-orm";

import { db } from "@/db";
import {
  generationImages,
  generationRefImages,
  generations,
  type GenerationStatus,
} from "@/db/schema";
import {
  toWireDetail,
  toWireRow,
  type WireGenerationDetail,
  type WireGenerationList,
  type WireUsageSummary,
} from "@/lib/api/wire";
import { generationImageDir } from "@/lib/paths";
import { round3 } from "@/providers/pricing";
import type { Mode, ProviderId } from "@/providers/types";

export interface ListGenerationsParams {
  providerId?: ProviderId;
  modelId?: string;
  mode?: Mode;
  /** History filters on outcome — Gallery leaves this unset and gets everything. */
  status?: GenerationStatus;
  limit?: number;
  offset?: number;
}

export function listGenerations(params: ListGenerationsParams = {}): WireGenerationList {
  const { providerId, modelId, mode, status, limit = 60, offset = 0 } = params;

  const conditions = [];
  if (providerId) conditions.push(eq(generations.providerId, providerId));
  if (modelId) conditions.push(eq(generations.modelId, modelId));
  if (mode) conditions.push(eq(generations.mode, mode));
  if (status) conditions.push(eq(generations.status, status));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = db
    .select()
    .from(generations)
    .where(where)
    .orderBy(desc(generations.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  // One extra query instead of N: fetch every image for the page, then group.
  const ids = rows.map((r) => r.id);
  const imageRows = ids.length
    ? db
        .select()
        .from(generationImages)
        .where(inArray(generationImages.generationId, ids))
        .orderBy(asc(generationImages.idx))
        .all()
    : [];

  const byGeneration = new Map<string, typeof imageRows>();
  for (const img of imageRows) {
    const list = byGeneration.get(img.generationId) ?? [];
    list.push(img);
    byGeneration.set(img.generationId, list);
  }

  const totalRow = db.select({ value: count() }).from(generations).where(where).get();

  return {
    generations: rows.map((r) => toWireRow(r, byGeneration.get(r.id) ?? [])),
    total: totalRow?.value ?? 0,
  };
}

/**
 * Every model id that appears in the history, for filter dropdowns. Asked of
 * the whole table rather than derived from a page, so paging can't shrink it.
 */
export function distinctModelIds(): string[] {
  return db
    .selectDistinct({ modelId: generations.modelId })
    .from(generations)
    .orderBy(asc(generations.modelId))
    .all()
    .map((r) => r.modelId);
}

export function getGeneration(id: string): WireGenerationDetail | undefined {
  const row = db.select().from(generations).where(eq(generations.id, id)).get();
  if (!row) return undefined;

  const images = db
    .select()
    .from(generationImages)
    .where(eq(generationImages.generationId, id))
    .orderBy(asc(generationImages.idx))
    .all();

  const refImages = db
    .select()
    .from(generationRefImages)
    .where(eq(generationRefImages.generationId, id))
    .orderBy(asc(generationRefImages.idx))
    .all();

  return toWireDetail(row, images, refImages);
}

/**
 * Delete a Generation and its images on disk. The FK cascade drops the
 * generation_images / generation_ref_images rows. Idempotent.
 */
export async function deleteGeneration(id: string): Promise<void> {
  db.delete(generations).where(eq(generations.id, id)).run();
  await fs.rm(generationImageDir(id), { recursive: true, force: true });
}

/**
 * Cumulative cost over successful Generations, per total / provider / model /
 * month (SPEC §6). `cost_usd` (actual) is the statistics source of truth.
 *
 * SUM over an empty set is NULL → coerced to 0. costUsd is a REAL column and
 * drizzle types SUM(...) as `string | null`, so each value goes through
 * Number(...) and the app's single rounding (pricing.round3).
 */
export function usageSummary(): WireUsageSummary {
  const successful = eq(generations.status, "success");
  const toCost = (v: string | number | null | undefined): number => round3(Number(v ?? 0));
  // createdAt is a unix timestamp (seconds); bucket by calendar month.
  const monthExpr = sql<string>`strftime('%Y-%m', datetime(${generations.createdAt}, 'unixepoch'))`;

  const totalRow = db
    .select({ costUsd: sum(generations.costUsd), count: count() })
    .from(generations)
    .where(successful)
    .get();

  const byProvider = db
    .select({ providerId: generations.providerId, costUsd: sum(generations.costUsd), count: count() })
    .from(generations)
    .where(successful)
    .groupBy(generations.providerId)
    .all();

  const byModel = db
    .select({ modelId: generations.modelId, costUsd: sum(generations.costUsd), count: count() })
    .from(generations)
    .where(successful)
    .groupBy(generations.modelId)
    .all();

  const byMonth = db
    .select({ month: monthExpr, costUsd: sum(generations.costUsd), count: count() })
    .from(generations)
    .where(successful)
    .groupBy(monthExpr)
    .orderBy(monthExpr)
    .all();

  return {
    total: { costUsd: toCost(totalRow?.costUsd), count: totalRow?.count ?? 0 },
    byProvider: byProvider.map((r) => ({
      providerId: r.providerId,
      costUsd: toCost(r.costUsd),
      count: r.count,
    })),
    byModel: byModel.map((r) => ({
      modelId: r.modelId,
      costUsd: toCost(r.costUsd),
      count: r.count,
    })),
    byMonth: byMonth.map((r) => ({
      month: r.month,
      costUsd: toCost(r.costUsd),
      count: r.count,
    })),
  };
}
