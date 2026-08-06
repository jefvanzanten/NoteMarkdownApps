import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { ApiRepository } from "./repository.js";
import { createApiApp } from "./app.js";

/** Starts the stateless Hono HTTP process without managing migrations. @returns Nothing. */
function start(): void {
  const config = loadConfig();
  const { db } = createDatabase(config.databaseUrl);
  const app = createApiApp({ config, repository: new ApiRepository(db) });
  serve({ fetch: app.fetch, port: config.port }, (info) => console.info(`NoteMarkdown API listening on ${info.port}`));
}

start();
