/**
 * GET /api/generations — gallery listing (SPEC §7).
 *
 * Newest-first page of generations with their output images. Optional filters:
 * `providerId`, `modelId`, `mode`; pagination via `limit` (default 60) /
 * `offset` (default 0). Returns every status so the gallery can surface
 * pending / error rows too.
 */

import { and, count, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { generationImages, generations } from "@/db/schema";
import type { Mode, ProviderId } from "@/providers/types";

export const runtime = "nodejs";

function parseNonNeg(value: string | null, fallback: number): number {
  const n = value === null ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const providerId = url.searchParams.get("providerId");
  const modelId = url.searchParams.get("modelId");
  const mode = url.searchParams.get("mode");
  const limit = parseNonNeg(url.searchParams.get("limit"), 60);
  const offset = parseNonNeg(url.searchParams.get("offset"), 0);

  const conditions = [];
  if (providerId) conditions.push(eq(generations.providerId, providerId as ProviderId));
  if (modelId) conditions.push(eq(generations.modelId, modelId));
  if (mode) conditions.push(eq(generations.mode, mode as Mode));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = db
    .select({
      id: generations.id,
      createdAt: generations.createdAt,
      providerId: generations.providerId,
      modelId: generations.modelId,
      mode: generations.mode,
      prompt: generations.prompt,
      sizeSpec: generations.sizeSpec,
      status: generations.status,
      costUsd: generations.costUsd,
      costSource: generations.costSource,
      timingMs: generations.timingMs,
      imageOutputTokens: generations.imageOutputTokens,
    })
    .from(generations)
    .where(where)
    .orderBy(desc(generations.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const ids = rows.map((r) => r.id);
  const imageRows = ids.length
    ? db
        .select({
          generationId: generationImages.generationId,
          idx: generationImages.idx,
          filePath: generationImages.filePath,
          thumbPath: generationImages.thumbPath,
          width: generationImages.width,
          height: generationImages.height,
          mimeType: generationImages.mimeType,
        })
        .from(generationImages)
        .where(inArray(generationImages.generationId, ids))
        .orderBy(generationImages.idx)
        .all()
    : [];

  const imagesByGen = new Map<string, Omit<(typeof imageRows)[number], "generationId">[]>();
  for (const { generationId, ...img } of imageRows) {
    const list = imagesByGen.get(generationId) ?? [];
    list.push(img);
    imagesByGen.set(generationId, list);
  }

  const totalRow = db.select({ value: count() }).from(generations).where(where).get();

  return Response.json({
    generations: rows.map((r) => ({ ...r, images: imagesByGen.get(r.id) ?? [] })),
    total: totalRow?.value ?? 0,
  });
}
