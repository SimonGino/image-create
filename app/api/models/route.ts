import { providerKeyStatuses } from "@/lib/provider-status";
import { listAllModels } from "@/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // key availability is read per request

/** Model catalog + per-provider key status — drives the UI model selector (SPEC §5, §7). */
export function GET(): Response {
  return Response.json({ providers: providerKeyStatuses(), models: listAllModels() });
}
