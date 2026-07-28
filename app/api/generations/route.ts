/**
 * GET /api/generations — Gallery / History listing (SPEC §7).
 *
 * Newest-first page of Generations with their output images. Optional filters
 * `providerId` / `modelId` / `mode` / `status` (unset = every status);
 * pagination via `limit` (default 60) / `offset` (default 0). The queries and
 * the wire shape belong to @/lib/generation-store.
 */

import type { GenerationStatus } from "@/db/schema";
import { listGenerations } from "@/lib/generation-store";
import type { Mode, ProviderId } from "@/providers/types";

export const runtime = "nodejs";

function parseNonNeg(value: string | null): number | undefined {
  const n = value === null ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function GET(req: Request): Response {
  const q = new URL(req.url).searchParams;

  return Response.json(
    listGenerations({
      providerId: (q.get("providerId") as ProviderId | null) ?? undefined,
      modelId: q.get("modelId") ?? undefined,
      mode: (q.get("mode") as Mode | null) ?? undefined,
      status: (q.get("status") as GenerationStatus | null) ?? undefined,
      limit: parseNonNeg(q.get("limit")),
      offset: parseNonNeg(q.get("offset")),
    }),
  );
}
