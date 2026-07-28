import { z } from "zod";

import type { WireProviderSetting } from "@/lib/api/wire";
import {
  getProviderCredentials,
  storedCredentials,
  updateStoredCredentials,
} from "@/lib/credentials";
import { PROVIDER_IDS } from "@/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never return the raw key — only whether one exists + a last-4 mask. */
function mask(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.length >= 4 ? `····${key.slice(-4)}` : "····";
}

export function GET(): Response {
  const effective = getProviderCredentials(); // env + file merged
  const stored = storedCredentials(); // file only — i.e. what Settings can edit

  const providers: WireProviderSetting[] = PROVIDER_IDS.map((id) => ({
    providerId: id,
    hasKey: Boolean(effective[id]?.apiKey),
    keyMasked: mask(effective[id]?.apiKey),
    baseUrl: effective[id]?.baseUrl ?? "",
    keyInFile: Boolean(stored[id]?.apiKey),
  }));
  return Response.json({ providers });
}

/** `""` and `null` are meaningful — see updateStoredCredentials for what each means. */
const providerUpdate = z.object({
  apiKey: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
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

  updateStoredCredentials(parsed.data);
  return Response.json({ ok: true });
}
