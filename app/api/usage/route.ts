/**
 * GET /api/usage — cumulative cost aggregates (SPEC §6). The aggregation itself
 * belongs to @/lib/generation-store.
 */

import { usageSummary } from "@/lib/generation-store";

// better-sqlite3 (via the store) needs the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // aggregates change as generations are recorded

export function GET(): Response {
  return Response.json(usageSummary());
}
