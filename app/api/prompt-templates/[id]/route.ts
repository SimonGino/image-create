/**
 * PATCH  /api/prompt-templates/[id] — update (e.g. toggle favorite, rename).
 * DELETE /api/prompt-templates/[id] — remove. Idempotent.
 *
 * Queries belong to @/lib/template-store.
 */

import { z } from "zod";

import { deleteTemplate, updateTemplate } from "@/lib/template-store";

export const runtime = "nodejs";

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  favorite: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return Response.json({ error: { code: "bad_request", message: "Nothing to update" } }, { status: 400 });
  }

  const updated = updateTemplate(id, parsed.data);
  if (!updated) {
    return Response.json({ error: { code: "not_found", message: "No such template" } }, { status: 404 });
  }
  return Response.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  deleteTemplate(id);
  return Response.json({ ok: true });
}
