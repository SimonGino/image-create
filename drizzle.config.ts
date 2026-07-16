import { defineConfig } from "drizzle-kit";

// Keep the DB path in sync with src/lib/paths.ts (DATA_DIR/app.db).
const dataDir = process.env.DATA_DIR ?? "./data";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: `${dataDir}/app.db`,
  },
  strict: true,
  verbose: true,
});
