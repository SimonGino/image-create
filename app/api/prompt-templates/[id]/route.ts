import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { promptTemplates } from "@/db/schema";

export const runtime = "nodejs";

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  favorite: z.boolean().optional(),
});

/** Update a template (e.g. toggle favorite, rename). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return Response.json({ error: { code: "bad_request", message: "Nothing to update" } }, { status: 400 });
  }
  db.update(promptTemplates).set(parsed.data).where(eq(promptTemplates.id, id)).run();
  const row = db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).get();
  if (!row) return Response.json({ error: { code: "not_found", message: "No such template" } }, { status: 404 });
  return Response.json(row);
}

/** Delete a template. Idempotent. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  db.delete(promptTemplates).where(eq(promptTemplates.id, id)).run();
  return Response.json({ ok: true });
}
