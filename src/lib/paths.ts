/**
 * Canonical filesystem layout. The DB and generated images live under DATA_DIR
 * (default ./data, git-ignored). Images go to data/images/{generationId}/{idx}.*
 * and only relative paths are stored in the DB (SPEC §4).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROJECT_ROOT = process.cwd();

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(PROJECT_ROOT, process.env.DATA_DIR)
  : path.join(PROJECT_ROOT, "data");

export const IMAGES_DIR = path.join(DATA_DIR, "images");
export const DB_FILE = path.join(DATA_DIR, "app.db");
export const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle");

/** Local key/settings override file (SPEC §5). */
export const CONFIG_FILE = process.env.IMAGE_CREATE_CONFIG
  ? path.resolve(PROJECT_ROOT, process.env.IMAGE_CREATE_CONFIG)
  : path.join(os.homedir(), ".image-create", "config.json");

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureDataDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(IMAGES_DIR);
}

export function generationImageDir(generationId: string): string {
  return path.join(IMAGES_DIR, generationId);
}

/** Store paths relative to project root so the DB stays portable. */
export function relFromRoot(absPath: string): string {
  return path.relative(PROJECT_ROOT, absPath);
}

export function absFromRoot(relPath: string): string {
  return path.isAbsolute(relPath) ? relPath : path.join(PROJECT_ROOT, relPath);
}
