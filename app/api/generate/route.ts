import { z } from "zod";

import { parseGenerateRequest } from "@/lib/request-schema";
import { httpStatusForCode, ImageProviderError, ValidationError } from "@/providers/errors";
import { runGeneration } from "@/services/generation";

// better-sqlite3 + sharp need the Node runtime.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: { code: "bad_request", message: "Invalid JSON body" } }, { status: 400 });
  }

  let req;
  try {
    req = parseGenerateRequest(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json(
        { error: { code: "bad_request", message: "Malformed request", issues: err.issues } },
        { status: 400 },
      );
    }
    throw err;
  }

  try {
    const summary = await runGeneration(req);
    return Response.json(summary, { status: 200 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return Response.json(
        { error: { code: "validation", message: err.message, issues: err.issues } },
        { status: 400 },
      );
    }
    if (err instanceof ImageProviderError) {
      return Response.json(
        { error: { code: err.code, message: err.message } },
        { status: httpStatusForCode(err.code) },
      );
    }
    console.error("[api/generate] unexpected error", err);
    return Response.json({ error: { code: "internal", message: "Generation failed" } }, { status: 500 });
  }
}
