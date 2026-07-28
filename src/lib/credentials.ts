/**
 * Provider credentials + endpoint config (SPEC §5, minimal v1) — the sole owner
 * of ~/.image-create/config.json: it reads the file, writes it, merges it over
 * .env, and owns what a Settings edit means. SERVER-SIDE ONLY — never import
 * this from a client component.
 *
 * Hybrid source: .env by default, overridden per-field by the config.json the
 * in-app Settings page manages.
 *
 * baseUrl is first-class: point either provider at a proxy / relay / custom
 * gateway. When a custom baseUrl is used you authenticate to that gateway, so
 * provider-side gates (e.g. OpenAI org verification) don't apply here.
 *
 * config.json shape: { "providers": { "openai": { "apiKey": "...", "baseUrl": "..." } } }
 * (a bare { "openai": { ... } } is also accepted). The file holds API keys: it
 * is written 0600 and its contents must never be logged or returned to a
 * client — the Settings route only ever exposes a last-4 mask.
 */

import fs from "node:fs";
import path from "node:path";

import type { ProviderSettingUpdate } from "@/lib/api/wire";
import { CONFIG_FILE } from "@/lib/paths";
import { PROVIDER_IDS, type ProviderId } from "@/providers/types";

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderCredentials {
  openai?: ProviderConfig;
  google?: ProviderConfig;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function fromEnv(): ProviderCredentials {
  const creds: ProviderCredentials = {};

  const openai: ProviderConfig = {
    apiKey: clean(process.env.OPENAI_API_KEY),
    // OPENAI_BASE_URL matches the OpenAI SDK convention; OPENAI_API_BASE kept as an alias.
    baseUrl: clean(process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE),
  };
  if (openai.apiKey || openai.baseUrl) creds.openai = openai;

  const google: ProviderConfig = {
    apiKey: clean(process.env.GOOGLE_API_KEY),
    baseUrl: clean(process.env.GOOGLE_BASE_URL ?? process.env.GEMINI_BASE_URL),
  };
  if (google.apiKey || google.baseUrl) creds.google = google;

  return creds;
}

function readConfigFile(): ProviderCredentials {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as { providers?: ProviderCredentials } & ProviderCredentials;
    return parsed.providers ?? parsed ?? {};
  } catch {
    // Missing/unreadable/invalid config is fine — fall back to env.
    return {};
  }
}

function writeConfigFile(creds: ProviderCredentials): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ providers: creds }, null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created — enforce it on overwrite too.
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // best-effort (e.g. a filesystem without POSIX modes)
  }
}

function mergeProvider(
  env: ProviderConfig | undefined,
  file: ProviderConfig | undefined,
): ProviderConfig | undefined {
  if (!env && !file) return undefined;
  return {
    apiKey: clean(file?.apiKey) ?? env?.apiKey,
    baseUrl: clean(file?.baseUrl) ?? env?.baseUrl,
  };
}

/** File overrides env, field by field, per provider. */
export function getProviderCredentials(): ProviderCredentials {
  const env = fromEnv();
  const file = readConfigFile();
  return {
    openai: mergeProvider(env.openai, file.openai),
    google: mergeProvider(env.google, file.google),
  };
}

export function getProviderConfig(providerId: ProviderId): ProviderConfig {
  return getProviderCredentials()[providerId] ?? {};
}

export function getApiKey(providerId: ProviderId): string | undefined {
  return getProviderConfig(providerId).apiKey;
}

export function getBaseUrl(providerId: ProviderId): string | undefined {
  return getProviderConfig(providerId).baseUrl;
}

/** A provider is usable once it has a key (base URL is optional). */
export function hasCredentials(providerId: ProviderId): boolean {
  return Boolean(getApiKey(providerId));
}

// ------------------------------------------------------- the stored file only

/**
 * What config.json holds, with no env merged in. Settings needs this to tell
 * "key came from .env" (read-only here) from "key is in the file" (editable).
 */
export function storedCredentials(): ProviderCredentials {
  return readConfigFile();
}

/**
 * Apply a Settings edit to config.json (SPEC §5). Each field is three-state:
 *   - undefined → leave it alone
 *   - null      → clear it (so .env, if set, takes over again)
 *   - a string  → set it, trimmed
 *
 * with one asymmetry the Settings form depends on: a blank `apiKey` means "I
 * didn't retype my key" and leaves the stored one intact, while a blank
 * `baseUrl` means "back to the provider's default" and clears it. A provider
 * whose entry ends up empty is dropped from the file entirely.
 */
export function updateStoredCredentials(
  updates: Partial<Record<ProviderId, ProviderSettingUpdate>>,
): void {
  const stored = readConfigFile();

  for (const id of PROVIDER_IDS) {
    const update = updates[id];
    if (!update) continue;
    const entry: ProviderConfig = { ...stored[id] };

    if (update.apiKey === null) delete entry.apiKey;
    else {
      const key = clean(update.apiKey ?? undefined);
      if (key) entry.apiKey = key;
    }

    if (update.baseUrl !== undefined) {
      const url = clean(update.baseUrl ?? undefined);
      if (url) entry.baseUrl = url;
      else delete entry.baseUrl;
    }

    if (Object.keys(entry).length === 0) delete stored[id];
    else stored[id] = entry;
  }

  writeConfigFile(stored);
}
