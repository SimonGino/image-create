/**
 * GET /api/generations/[id]    — one Generation as WireGenerationDetail.
 * DELETE /api/generations/[id] — remove the row (FK cascade drops images/refs)
 *                                and the on-disk image folder. Idempotent.
 *
 * DELETE is also consumed by the right-preview 删除 button.
 */

import { deleteGeneration, getGeneration } from "@/lib/generation-store";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const detail = getGeneration(id);
  if (!detail) {
    return Response.json(
      { error: { code: "not_found", message: "No such generation" } },
      { status: 404 },
    );
  }
  return Response.json(detail);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await deleteGeneration(id);
  return Response.json({ ok: true });
}
