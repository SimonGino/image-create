/**
 * SQLite schema (SPEC §4). Mirrors the provider request/response (SPEC §3):
 * `size_spec` / `provider_params` are JSON columns typed to the discriminated
 * unions. Images live on the filesystem — only relative paths are stored here.
 *
 * usage is inlined into `generations` for v1 (single user, one row per
 * generation). Split into `usage_records` later if finer analysis is needed.
 *
 * Kept dependency-light (drizzle + type-only imports) so drizzle-kit can load it.
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { Mode, OutputFormat, ProviderId, Quality, SizeSpec } from "../providers/types";

export type GenerationStatus = "pending" | "success" | "error";
export type CostSource = "estimated" | "actual";
export type RefImageRole = "image" | "mask";

const uuid = () => crypto.randomUUID();

export const generations = sqliteTable(
  "generations",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    providerId: text("provider_id").$type<ProviderId>().notNull(),
    modelId: text("model_id").notNull(),
    mode: text("mode").$type<Mode>().notNull(),
    prompt: text("prompt").notNull(),
    sizeSpec: text("size_spec", { mode: "json" }).$type<SizeSpec>().notNull(),
    quality: text("quality").$type<Quality>(),
    outputFormat: text("output_format").$type<OutputFormat>(),
    nRequested: integer("n_requested").notNull().default(1),
    providerParams: text("provider_params", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status").$type<GenerationStatus>().notNull().default("pending"),
    errorCode: text("error_code"),
    timingMs: integer("timing_ms"),
    // usage (inlined)
    textInputTokens: integer("text_input_tokens"),
    imageInputTokens: integer("image_input_tokens"),
    imageOutputTokens: integer("image_output_tokens"),
    costUsd: real("cost_usd"),
    costSource: text("cost_source").$type<CostSource>(),
  },
  (t) => [
    index("gen_created_idx").on(t.createdAt),
    index("gen_provider_model_idx").on(t.providerId, t.modelId),
    index("gen_mode_idx").on(t.mode),
    index("gen_status_idx").on(t.status),
  ],
);

export const generationImages = sqliteTable(
  "generation_images",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    generationId: text("generation_id")
      .notNull()
      .references(() => generations.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    filePath: text("file_path").notNull(),
    thumbPath: text("thumb_path"),
    width: integer("width"),
    height: integer("height"),
    mimeType: text("mime_type").notNull(),
  },
  (t) => [index("gen_images_generation_idx").on(t.generationId)],
);

export const generationRefImages = sqliteTable(
  "generation_ref_images",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    generationId: text("generation_id")
      .notNull()
      .references(() => generations.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    filePath: text("file_path").notNull(),
    role: text("role").$type<RefImageRole>().notNull().default("image"),
  },
  (t) => [index("gen_ref_images_generation_idx").on(t.generationId)],
);

export const promptTemplates = sqliteTable("prompt_templates", {
  id: text("id").primaryKey().$defaultFn(uuid),
  title: text("title").notNull(),
  body: text("body").notNull(),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  variables: text("variables", { mode: "json" }).$type<string[]>(),
  defaultProviderId: text("default_provider_id").$type<ProviderId>(),
  defaultModelId: text("default_model_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Generation = typeof generations.$inferSelect;
export type NewGeneration = typeof generations.$inferInsert;
export type GenerationImage = typeof generationImages.$inferSelect;
export type NewGenerationImage = typeof generationImages.$inferInsert;
export type GenerationRefImage = typeof generationRefImages.$inferSelect;
export type NewGenerationRefImage = typeof generationRefImages.$inferInsert;
export type PromptTemplate = typeof promptTemplates.$inferSelect;
export type NewPromptTemplate = typeof promptTemplates.$inferInsert;
