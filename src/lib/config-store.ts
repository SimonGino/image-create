/**
 * Read/write the local settings file (~/.image-create/config.json) that the
 * in-app Settings page manages (SPEC §5). Server-only. Written 0600 (owner
 * read/write); this file holds API keys — never log its contents.
 *
 * Shape: { "providers": { "openai": { "apiKey"?, "baseUrl"? }, "google": {...} } }
 * (credentials.ts reads the same shape, file overriding env per field.)
 */

import fs from "node:fs";
import path from "node:path";

import { CONFIG_FILE } from "@/lib/paths";

export interface ProviderConfigEntry {
  apiKey?: string;
  baseUrl?: string;
}

export interface ConfigStore {
  providers: {
    openai?: ProviderConfigEntry;
    google?: ProviderConfigEntry;
  };
}

export function readConfigStore(): ConfigStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as {
      providers?: ConfigStore["providers"];
    } & ConfigStore["providers"];
    return { providers: parsed.providers ?? parsed ?? {} };
  } catch {
    return { providers: {} };
  }
}

export function writeConfigStore(store: ConfigStore): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  // mode on writeFileSync only applies at creation; enforce on overwrite too.
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // best-effort (e.g. unsupported FS)
  }
}
