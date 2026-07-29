/**
 * The HTTP contract between the routes and the browser: one response shape per
 * endpoint, shared by both sides so a schema change is a compile error rather
 * than a silent drift.
 *
 * Two rules make a single client type fit every endpoint:
 *   1. Absent values are always `undefined` (omitted from JSON), never `null` —
 *      the mappers here normalise drizzle's nulls.
 *   2. A Generation has exactly two projections: `WireGenerationRow` (the
 *      Gallery / History listing) and `WireGenerationDetail` (which extends it).
 *      POST /api/generate and GET /api/generations/[id] both return the detail.
 *
 * Types + pure mappers only — no db, no fs, no fetch. Safe to import from
 * client components (the `@/db/schema` imports are type-only and erased).
 */

import type {
  Generation,
  GenerationImage,
  GenerationRefImage,
  GenerationStatus,
  PromptTemplate,
  RefImageRole,
} from "@/db/schema";
import type { CostSource } from "@/providers/pricing";
import type {
  Mode,
  OutputFormat,
  ProviderId,
  Quality,
  SizeSpec,
} from "@/providers/types";

/** `null` → `undefined`, so every wire field is plain-optional. */
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

// ---------------------------------------------------------------- error shape

/** The envelope every route returns on failure: `{ error: ApiErrorBody }`. */
export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: { path?: string | (string | number)[]; code: string; message: string }[];
}

// ------------------------------------------------------------ provider status

/**
 * Per-provider key availability. Computed server-side and handed to the pages
 * as props (also the shape of GET /api/models).
 */
export interface ProviderKeyStatus {
  providerId: ProviderId;
  hasKey: boolean;
}

/** GET /api/settings — one entry per provider. Never carries the raw key. */
export interface WireProviderSetting extends ProviderKeyStatus {
  keyMasked?: string;
  baseUrl: string;
  /** Whether config.json holds the key, i.e. whether Settings can clear it. */
  keyInFile: boolean;
}

/** POST /api/settings — `""` leaves a field alone, `null` clears it. */
export interface ProviderSettingUpdate {
  apiKey?: string | null;
  baseUrl?: string | null;
}

// ----------------------------------------------------------------- generation

export interface WireImage {
  idx: number;
  filePath: string;
  thumbPath?: string;
  width?: number;
  height?: number;
  mimeType: string;
}

export interface WireRefImage {
  idx: number;
  filePath: string;
  role: RefImageRole;
}

export interface WireUsage {
  textInputTokens?: number;
  imageInputTokens?: number;
  imageOutputTokens?: number;
}

/** Gallery / History row — GET /api/generations. */
export interface WireGenerationRow {
  id: string;
  createdAt: string; // ISO-8601
  providerId: ProviderId;
  modelId: string;
  mode: Mode;
  prompt: string;
  sizeSpec: SizeSpec;
  /** How many images were asked for — History compares it against `images`. */
  nRequested: number;
  status: GenerationStatus;
  /** Failure code, or `partial_failure:<code>` when some fan-out shots failed. */
  errorCode?: string;
  costUsd?: number;
  costSource?: CostSource;
  timingMs?: number;
  images: WireImage[];
}

/** Full Generation — GET /api/generations/[id] and POST /api/generate. */
export interface WireGenerationDetail extends WireGenerationRow {
  quality?: Quality;
  outputFormat?: OutputFormat;
  providerParams?: Record<string, unknown>;
  usage: WireUsage;
  refImages: WireRefImage[];
}

export interface WireGenerationList {
  generations: WireGenerationRow[];
  total: number;
}

const PARTIAL_PREFIX = "partial_failure:";

/**
 * The underlying provider code when some fan-out shots failed but their
 * siblings were kept, else undefined. A partial failure keeps `status:
 * "success"` — the billed images are real — so this is how a view spots it.
 */
export function partialFailureCode(errorCode: string | undefined): string | undefined {
  return errorCode?.startsWith(PARTIAL_PREFIX)
    ? errorCode.slice(PARTIAL_PREFIX.length)
    : undefined;
}

// ---------------------------------------------------------------------- usage

export interface WireUsageBucket {
  costUsd: number;
  count: number;
}

/** GET /api/usage — cumulative cost over successful Generations (SPEC §6). */
export interface WireUsageSummary {
  total: WireUsageBucket;
  byProvider: (WireUsageBucket & { providerId: string })[];
  byModel: (WireUsageBucket & { modelId: string })[];
  byMonth: (WireUsageBucket & { month: string })[];
}

// ------------------------------------------------------------ prompt template

export interface WirePromptTemplate {
  id: string;
  title: string;
  body: string;
  favorite: boolean;
  variables?: string[];
  defaultProviderId?: ProviderId;
  defaultModelId?: string;
  /** Card cover image path. May dangle after that generation is deleted. */
  coverImagePath?: string;
  createdAt: string; // ISO-8601
}

export interface PromptTemplateInput {
  title: string;
  body: string;
  favorite?: boolean;
  variables?: string[];
  defaultProviderId?: ProviderId;
  defaultModelId?: string;
  coverImagePath?: string;
}

export interface PromptTemplatePatch {
  title?: string;
  body?: string;
  favorite?: boolean;
}

// -------------------------------------------------------------- row → wire

export function toWireImage(row: GenerationImage): WireImage {
  return {
    idx: row.idx,
    filePath: row.filePath,
    thumbPath: opt(row.thumbPath),
    width: opt(row.width),
    height: opt(row.height),
    mimeType: row.mimeType,
  };
}

export function toWireRefImage(row: GenerationRefImage): WireRefImage {
  return { idx: row.idx, filePath: row.filePath, role: row.role };
}

export function toWireRow(row: Generation, images: GenerationImage[]): WireGenerationRow {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    providerId: row.providerId,
    modelId: row.modelId,
    mode: row.mode,
    prompt: row.prompt,
    sizeSpec: row.sizeSpec,
    nRequested: row.nRequested,
    status: row.status,
    errorCode: opt(row.errorCode),
    costUsd: opt(row.costUsd),
    costSource: opt(row.costSource),
    timingMs: opt(row.timingMs),
    images: images.map(toWireImage),
  };
}

export function toWireDetail(
  row: Generation,
  images: GenerationImage[],
  refImages: GenerationRefImage[],
): WireGenerationDetail {
  return {
    ...toWireRow(row, images),
    quality: opt(row.quality),
    outputFormat: opt(row.outputFormat),
    providerParams: opt(row.providerParams),
    usage: {
      textInputTokens: opt(row.textInputTokens),
      imageInputTokens: opt(row.imageInputTokens),
      imageOutputTokens: opt(row.imageOutputTokens),
    },
    refImages: refImages.map(toWireRefImage),
  };
}

export function toWireTemplate(row: PromptTemplate): WirePromptTemplate {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    favorite: row.favorite,
    variables: opt(row.variables),
    defaultProviderId: opt(row.defaultProviderId),
    defaultModelId: opt(row.defaultModelId),
    coverImagePath: opt(row.coverImagePath),
    createdAt: row.createdAt.toISOString(),
  };
}
