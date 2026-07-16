import { z } from "zod";

import { readConfigStore, writeConfigStore } from "@/lib/config-store";
import { getProviderCredentials } from "@/lib/credentials";
import type { ProviderId } from "@/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: ProviderId[] = ["openai", "google"];

/** Never return the raw key — only whether one exists + a last-4 mask. */
function mask(key: string | undefined): string | null {
  if (!key) return null;
  return key.length >= 4 ? `····${key.slice(-4)}` : "····";
}

export function GET(): Response {
  const effective = getProviderCredentials(); // env + file merged
  const store = readConfigStore();

  const providers = PROVIDERS.map((id) => {
    const eff = effective[id];
    return {
      providerId: id,
      hasKey: Boolean(eff?.apiKey),
      keyMasked: mask(eff?.apiKey),
      baseUrl: eff?.baseUrl ?? "",
      keyInFile: Boolean(store.providers[id]?.apiKey), // whether Settings can edit/clear it
    };
  });
  return Response.json({ providers });
}

const providerUpdate = z.object({
  apiKey: z.string().nullable().optional(), // string=set, ""=leave, null=clear, undefined=leave
  baseUrl: z.string().nullable().optional(), // string=set, ""/null=clear, undefined=leave
});
const bodySchema = z.object({
  openai: providerUpdate.optional(),
  google: providerUpdate.optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { code: "bad_request", message: "Malformed settings" } }, { status: 400 });
  }

  const store = readConfigStore();
  for (const id of PROVIDERS) {
    const upd = parsed.data[id];
    if (!upd) continue;
    const entry = { ...(store.providers[id] ?? {}) };

    if (upd.apiKey !== undefined) {
      if (upd.apiKey === null) delete entry.apiKey; // explicit clear
      else if (upd.apiKey.trim() !== "") entry.apiKey = upd.apiKey.trim(); // set (blank = leave)
    }
    if (upd.baseUrl !== undefined) {
      if (upd.baseUrl === null || upd.baseUrl.trim() === "") delete entry.baseUrl;
      else entry.baseUrl = upd.baseUrl.trim();
    }

    if (Object.keys(entry).length === 0) delete store.providers[id];
    else store.providers[id] = entry;
  }

  writeConfigStore(store);
  return Response.json({ ok: true });
}
