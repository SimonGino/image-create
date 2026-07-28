/**
 * GET  /api/prompt-templates — list (favorites first, then newest).
 * POST /api/prompt-templates — create.
 *
 * Queries belong to @/lib/template-store.
 */

import { z } from "zod";

import { createTemplate, listTemplates } from "@/lib/template-store";
import { PROVIDER_IDS } from "@/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ templates: listTemplates() });
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  favorite: z.boolean().optional(),
  variables: z.array(z.string()).optional(),
  defaultProviderId: z.enum(PROVIDER_IDS).optional(),
  defaultModelId: z.string().optional(),
  coverImagePath: z.string().optional(),
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

  return Response.json(createTemplate(parsed.data), { status: 201 });
}
