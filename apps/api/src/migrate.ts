import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";

/** Applies forward-only Drizzle migrations and closes the database pool. @returns Nothing after migration. */
async function run(): Promise<void> {
  const { pool, db } = createDatabase(loadConfig().databaseUrl);
  try { await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname }); } finally { await pool.end(); }
}

void run();
