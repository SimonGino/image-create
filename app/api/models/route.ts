import { hasCredentials } from "@/lib/credentials";
import { listAdapters, listAllModels } from "@/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // key availability is read per request

/** Model catalog + per-provider key status — drives the UI model selector (SPEC §5, §7). */
export function GET(): Response {
  const providers = listAdapters().map((a) => ({
    providerId: a.providerId,
    hasKey: hasCredentials(a.providerId),
  }));
  return Response.json({ providers, models: listAllModels() });
}
