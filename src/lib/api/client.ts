/**
 * The browser's single seam onto /api/*. Every call goes through `request()`,
 * so there is one error policy for the whole app: a non-2xx response becomes a
 * thrown `ApiError` carrying the route's `{ code, message, issues }` envelope,
 * and a network failure becomes an `ApiError` with code `network`.
 *
 * Callers choose what to do with a failure (show it, ignore it) but no longer
 * choose *how* to detect one. Response types come from ./wire — the same
 * declarations the routes are typed against.
 */

import type {
  ApiErrorBody,
  ProviderSettingUpdate,
  PromptTemplateInput,
  PromptTemplatePatch,
  WireGenerationDetail,
  WireGenerationList,
  WirePromptTemplate,
  WireProviderSetting,
  WireUsageSummary,
} from "@/lib/api/wire";
import type { GenerationStatus } from "@/db/schema";
import type { GenerateRequest, Mode, ProviderId, RefImage } from "@/providers/types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues?: ApiErrorBody["issues"];

  constructor(body: ApiErrorBody, status: number) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.issues = body.issues;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(
      { code: "network", message: err instanceof Error ? err.message : "网络错误" },
      0,
    );
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const envelope = (body as { error?: unknown } | null)?.error;
    if (envelope && typeof envelope === "object") {
      const e = envelope as Partial<ApiErrorBody>;
      throw new ApiError(
        { code: e.code ?? "error", message: e.message ?? `HTTP ${res.status}`, issues: e.issues },
        res.status,
      );
    }
    throw new ApiError({ code: "error", message: `HTTP ${res.status}` }, res.status);
  }

  return body as T;
}

function postJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ----------------------------------------------------------------- generation

/** Run a Generation. Reference inputs ride along as base64 payloads. */
export function generate(
  req: GenerateRequest,
  refImages?: RefImage[],
): Promise<WireGenerationDetail> {
  return postJson<WireGenerationDetail>("/api/generate", {
    ...req,
    ...(refImages?.length ? { refImages } : {}),
  });
}

/** Filters are applied server-side; omitting `status` returns every status. */
export interface ListGenerationsQuery {
  providerId?: ProviderId;
  modelId?: string;
  mode?: Mode;
  status?: GenerationStatus;
  limit?: number;
  offset?: number;
}

export function listGenerations(query: ListGenerationsQuery = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return request<WireGenerationList>(`/api/generations${qs ? `?${qs}` : ""}`);
}

export function getGeneration(id: string): Promise<WireGenerationDetail> {
  return request<WireGenerationDetail>(`/api/generations/${id}`);
}

export function deleteGeneration(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/generations/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------- usage

export function getUsage(): Promise<WireUsageSummary> {
  return request<WireUsageSummary>("/api/usage");
}

// ------------------------------------------------------------ prompt template

export async function listTemplates(): Promise<WirePromptTemplate[]> {
  const { templates } = await request<{ templates: WirePromptTemplate[] }>("/api/prompt-templates");
  return templates ?? [];
}

export function createTemplate(input: PromptTemplateInput): Promise<WirePromptTemplate> {
  return postJson<WirePromptTemplate>("/api/prompt-templates", input);
}

export function updateTemplate(
  id: string,
  patch: PromptTemplatePatch,
): Promise<WirePromptTemplate> {
  return postJson<WirePromptTemplate>(`/api/prompt-templates/${id}`, patch, "PATCH");
}

export function deleteTemplate(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/prompt-templates/${id}`, { method: "DELETE" });
}

// ------------------------------------------------------------------- settings

export async function getSettings(): Promise<WireProviderSetting[]> {
  const { providers } = await request<{ providers: WireProviderSetting[] }>("/api/settings");
  return providers ?? [];
}

export function saveSettings(
  updates: Partial<Record<ProviderId, ProviderSettingUpdate>>,
): Promise<{ ok: true }> {
  return postJson<{ ok: true }>("/api/settings", updates);
}

// ----------------------------------------------------------------- media urls

/**
 * Browser URL for a stored image path. Paths are
 * `<DATA_DIR>/images/{generationId}/{file}` and the media route serves
 * everything under the images dir, so strip up to and including `/images/`
 * rather than assuming DATA_DIR is the default `data`.
 */
export function mediaUrl(filePath: string): string {
  return "/api/images/" + filePath.replace(/^.*?\/images\//, "");
}

/** Fetch an image and save it to disk under `filename`. */
export async function downloadImage(filePath: string, filename: string): Promise<void> {
  const res = await fetch(mediaUrl(filePath));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Read a blob (an uploaded file, or a fetched generated image) as base64. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Load an already-generated image (by media URL) as a base64 reference input. */
export async function refImageFromUrl(url: string): Promise<RefImage> {
  const blob = await (await fetch(url)).blob();
  return { data: await blobToBase64(blob), mimeType: blob.type || "image/png" };
}
