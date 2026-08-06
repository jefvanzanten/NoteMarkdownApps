import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const result = spawnSync(
  "cargo",
  ["build", "--manifest-path", resolve(packageRoot, "Cargo.toml"), "--release", "--target", "wasm32-unknown-unknown"],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const source = resolve(packageRoot, "target/wasm32-unknown-unknown/release/note_markdown_wasm.wasm");
const destination = resolve(repositoryRoot, "apps/web-app/public/notemarkdown_renderer.wasm");
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`Copied renderer to ${destination}`);
