import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasm = await readFile(resolve(packageRoot, "target/wasm32-unknown-unknown/release/note_markdown_wasm.wasm"));
const { instance } = await WebAssembly.instantiate(wasm, {});
const renderer = instance.exports;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Creates deterministic mixed-GFM Markdown near a target byte count.
 * @param targetBytes Approximate source size.
 * @returns Representative synthetic Markdown.
 */
function createDocument(targetBytes) {
  const block = [
    "## Local-first section",
    "",
    "A paragraph with **strong text**, [a relative link](notes/next.md), and `inline code`.",
    "",
    "| State | Meaning |",
    "| --- | --- |",
    "| clean | provider current |",
    "",
    "- [x] durable",
    "- [ ] synchronized",
    "",
    "```typescript",
    'const note: string = "local";',
    "```",
    "",
  ].join("\n");
  return (`# NoteMarkdown benchmark\n\n${block.repeat(Math.ceil(targetBytes / block.length))}`).slice(0, targetBytes);
}

/**
 * Renders one document through the production WASM ABI.
 * @param markdown Synthetic Markdown source.
 * @returns Duration and output size.
 */
function render(markdown) {
  const input = encoder.encode(markdown);
  const pointer = renderer.allocate(input.length);
  new Uint8Array(renderer.memory.buffer, pointer, input.length).set(input);
  const startedAt = performance.now();
  const packed = renderer.render(pointer, input.length);
  const durationMs = performance.now() - startedAt;
  const outputPointer = Number(packed >> 32n);
  const outputLength = Number(packed & 0xffff_ffffn);
  JSON.parse(decoder.decode(new Uint8Array(renderer.memory.buffer, outputPointer, outputLength)));
  renderer.deallocate(outputPointer, outputLength);
  return { durationMs, outputLength };
}

render(createDocument(64 * 1024));
const oneMb = render(createDocument(1024 * 1024));
const tenMb = render(createDocument(10 * 1024 * 1024));
const results = {
  runtime: process.version,
  platform: `${process.platform}/${process.arch}`,
  oneMb,
  tenMb,
  budgets: { oneMbMs: 100, tenMbMs: 750 },
};
console.log(JSON.stringify(results, null, 2));
if (oneMb.durationMs > 100 || tenMb.durationMs > 750) process.exitCode = 1;
