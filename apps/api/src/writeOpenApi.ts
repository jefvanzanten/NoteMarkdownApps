import { writeFile } from "node:fs/promises";
import { createApiApp } from "./app.js";
import type { ApiConfig } from "./config.js";
import type { ApiRepository } from "./repository.js";

/** Generates OpenAPI from the same runtime route schemas used by Hono. @returns Nothing after writing the specification. */
async function writeSpecification(): Promise<void> {
  const config = { publicOrigin: "https://notemarkdown.invalid", googleClientId: "spec", secureCookies: true } as ApiConfig;
  const app = createApiApp({ config, repository: {} as ApiRepository });
  const document = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "NoteMarkdown metadata API", version: "1.0.0" } });
  await writeFile(new URL("../openapi.json", import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
}

void writeSpecification();
