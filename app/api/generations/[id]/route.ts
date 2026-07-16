/**
 * GET /api/generations/[id]    — one generation (all columns + images + refs).
 * DELETE /api/generations/[id] — remove the row (FK cascade drops images/refs)
 *                                and the on-disk image folder. Idempotent.
 *
 * DELETE is also consumed by the right-preview 删除 button.
 */

import fs from "node:fs/promises";

import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { generationImages, generationRefImages, generations } from "@/db/schema";
import { generationImageDir } from "@/lib/paths";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const generation = db.select().from(generations).where(eq(generations.id, id)).get();
  if (!generation) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

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

  return Response.json({ ...generation, images, refImages });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  // FK cascade removes generation_images / generation_ref_images rows.
  db.delete(generations).where(eq(generations.id, id)).run();
  await fs.rm(generationImageDir(id), { recursive: true, force: true });

  return Response.json({ ok: true });
}
