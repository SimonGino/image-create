/**
 * SQLite connection (better-sqlite3 + Drizzle). Server-only.
 *
 * Opens DATA_DIR/app.db, enables WAL + foreign keys, and self-applies any
 * generated migrations on first import — a single local command is enough to
 * boot the app (SPEC §2). Singleton-guarded so Next dev HMR doesn't re-open it.
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { DB_FILE, MIGRATIONS_DIR, ensureDataDirs } from "@/lib/paths";
import * as schema from "./schema";

type DrizzleDb = BetterSQLite3Database<typeof schema>;

const globalForDb = globalThis as unknown as {
  __sqlite?: Database.Database;
  __db?: DrizzleDb;
  __migrated?: boolean;
};

function open(): DrizzleDb {
  ensureDataDirs();
  const sqlite = globalForDb.__sqlite ?? new Database(DB_FILE);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  globalForDb.__sqlite = sqlite;

  const database = globalForDb.__db ?? drizzle(sqlite, { schema });
  globalForDb.__db = database;

  // Apply migrations once per process, if they've been generated.
  const journal = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  if (!globalForDb.__migrated && fs.existsSync(journal)) {
    migrate(database, { migrationsFolder: MIGRATIONS_DIR });
    globalForDb.__migrated = true;
  }

  return database;
}

export const db = open();
export { schema };
