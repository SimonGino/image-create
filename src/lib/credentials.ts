/**
 * Provider credentials + endpoint config (SPEC §5, minimal v1).
 *
 * Hybrid source: .env by default, overridden per-field by a local config.json
 * (~/.image-create/config.json) written by in-app Settings. Read SERVER-SIDE
 * ONLY — never import this from a client component.
 *
 * baseUrl is first-class: point either provider at a proxy / relay / custom
 * gateway. When a custom baseUrl is used you authenticate to that gateway, so
 * provider-side gates (e.g. OpenAI org verification) don't apply here.
 *
 * config.json shape: { "providers": { "openai": { "apiKey": "...", "baseUrl": "..." } } }
 * (a bare { "openai": { ... } } is also accepted).
 */

import fs from "node:fs";

import { CONFIG_FILE } from "@/lib/paths";
import type { ProviderId } from "@/providers/types";

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
