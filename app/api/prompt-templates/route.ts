import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { promptTemplates } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List templates — favorites first, then newest. */
export function GET(): Response {
  const templates = db
    .select()
    .from(promptTemplates)
    .orderBy(desc(promptTemplates.favorite), desc(promptTemplates.createdAt))
    .all();
  return Response.json({ templates });
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  favorite: z.boolean().optional(),
  variables: z.array(z.string()).optional(),
  defaultProviderId: z.enum(["openai", "google"]).optional(),
  defaultModelId: z.string().optional(),
});

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: { code: "bad_request", message: "Invalid JSON" } }, { status: 400 });
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: { code: "bad_request", message: "Malformed template", issues: parsed.error.issues } },
      { status: 400 },
    );
  }

  const id = crypto.randomUUID();
  db.insert(promptTemplates)
    .values({ id, ...parsed.data })
    .run();
  const row = db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).get();
  return Response.json(row, { status: 201 });
}
