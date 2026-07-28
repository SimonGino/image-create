/**
 * Every server-side read and write of Prompt Templates, in the wire shapes the
 * browser consumes (SPEC §7). Same arrangement as @/lib/generation-store: the
 * routes translate HTTP, this module owns the queries and the ordering rule
 * (favorites first, then newest).
 *
 * Node-only (better-sqlite3 via @/db) — routes and scripts, never components.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { promptTemplates } from "@/db/schema";
import {
  toWireTemplate,
  type PromptTemplateInput,
  type PromptTemplatePatch,
  type WirePromptTemplate,
} from "@/lib/api/wire";

export function listTemplates(): WirePromptTemplate[] {
  return db
    .select()
    .from(promptTemplates)
    .orderBy(desc(promptTemplates.favorite), desc(promptTemplates.createdAt))
    .all()
    .map(toWireTemplate);
}

export function getTemplate(id: string): WirePromptTemplate | undefined {
  const row = db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).get();
  return row ? toWireTemplate(row) : undefined;
}

export function createTemplate(input: PromptTemplateInput): WirePromptTemplate {
  const id = crypto.randomUUID();
  db.insert(promptTemplates)
    .values({ id, ...input })
    .run();
  const created = getTemplate(id);
  if (!created) throw new Error("Template vanished after writing");
  return created;
}

/** Apply a partial update. Returns undefined when there is no such template. */
export function updateTemplate(
  id: string,
  patch: PromptTemplatePatch,
): WirePromptTemplate | undefined {
  db.update(promptTemplates).set(patch).where(eq(promptTemplates.id, id)).run();
  return getTemplate(id);
}

/** Idempotent. */
export function deleteTemplate(id: string): void {
  db.delete(promptTemplates).where(eq(promptTemplates.id, id)).run();
}
