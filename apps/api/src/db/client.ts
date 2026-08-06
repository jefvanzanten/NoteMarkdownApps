import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

/**
 * Creates the PostgreSQL pool and typed Drizzle client.
 * @param databaseUrl PostgreSQL connection URL.
 * @returns Database pool and Drizzle client.
 */
export function createDatabase(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Database = ReturnType<typeof createDatabase>["db"];
