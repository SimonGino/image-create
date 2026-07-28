/**
 * Which Providers have a usable key right now — read per request from env +
 * config.json. Every page hands this to AppHeader / Console / Compare so the UI
 * can grey out models whose Provider isn't configured (SPEC §7).
 *
 * Node-only (reads the filesystem) — pages and routes, never components.
 */

import type { ProviderKeyStatus } from "@/lib/api/wire";
import { hasCredentials } from "@/lib/credentials";
import { listAdapters } from "@/providers/registry";

export function providerKeyStatuses(): ProviderKeyStatus[] {
  return listAdapters().map((a) => ({
    providerId: a.providerId,
    hasKey: hasCredentials(a.providerId),
  }));
}
