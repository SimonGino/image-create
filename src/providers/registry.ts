/**
 * Adapter registry (SPEC §3). The single lookup layer everything above the
 * abstraction talks to. Adding a third provider = register its adapter here.
 */

import { GoogleAdapter } from "./google/adapter";
import { OpenAIAdapter } from "./openai/adapter";
import type { ImageProviderAdapter, ModelDescriptor, ProviderId } from "./types";

const adapters = new Map<ProviderId, ImageProviderAdapter>();

export function registerAdapter(adapter: ImageProviderAdapter): void {
  adapters.set(adapter.providerId, adapter);
}

/** Throws if the provider isn't registered — callers should catch and surface. */
export function getAdapter(providerId: ProviderId): ImageProviderAdapter {
  const adapter = adapters.get(providerId);
  if (!adapter) throw new Error(`No adapter registered for provider '${providerId}'`);
  return adapter;
}

export function hasAdapter(providerId: ProviderId): boolean {
  return adapters.has(providerId);
}

export function listAdapters(): ImageProviderAdapter[] {
  return [...adapters.values()];
}

export function listAllModels(): ModelDescriptor[] {
  return listAdapters().flatMap((a) => a.listModels());
}

export function getModel(providerId: ProviderId, modelId: string): ModelDescriptor | undefined {
  return adapters
    .get(providerId)
    ?.listModels()
    .find((m) => m.id === modelId);
}

// --- Built-in registrations -------------------------------------------------
registerAdapter(new OpenAIAdapter());
registerAdapter(new GoogleAdapter());
