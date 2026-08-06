/// <reference lib="webworker" />

import type { MarkdownRenderResult, RenderRequest, RenderResponse } from "@note/markdown-wasm";

type RendererExports = {
  memory: WebAssembly.Memory;
  allocate: (length: number) => number;
  render: (pointer: number, length: number) => bigint;
  deallocate: (pointer: number, length: number) => void;
};

let rendererPromise: Promise<RendererExports> | null = null;

/**
 * Loads and instantiates the coherent Rust renderer asset once.
 * @returns The low-level renderer exports.
 */
async function loadRenderer(): Promise<RendererExports> {
  if (rendererPromise) return rendererPromise;
  rendererPromise = (async () => {
    const assetUrl = new URL(`${import.meta.env.BASE_URL}notemarkdown_renderer.wasm`, self.location.origin);
    const response = await fetch(assetUrl);
    if (!response.ok) throw new Error(`Renderer could not be loaded (${response.status}).`);
    let module: WebAssembly.WebAssemblyInstantiatedSource;
    try {
      module = await WebAssembly.instantiateStreaming(response.clone(), {});
    } catch {
      module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    }
    return module.instance.exports as unknown as RendererExports;
  })();
  return rendererPromise;
}

/**
 * Sends one coarse UTF-8 payload through the WASM renderer ABI.
 * @param markdown UTF-8 Markdown source.
 * @returns Parsed render result from the Rust JSON output.
 */
async function renderWithWasm(markdown: string): Promise<MarkdownRenderResult> {
  const renderer = await loadRenderer();
  const input = new TextEncoder().encode(markdown);
  const inputPointer = renderer.allocate(input.length);
  new Uint8Array(renderer.memory.buffer, inputPointer, input.length).set(input);
  const packed = renderer.render(inputPointer, input.length);
  const outputPointer = Number(packed >> 32n);
  const outputLength = Number(packed & 0xffff_ffffn);
  const output = new Uint8Array(renderer.memory.buffer, outputPointer, outputLength).slice();
  renderer.deallocate(outputPointer, outputLength);
  return JSON.parse(new TextDecoder().decode(output)) as MarkdownRenderResult;
}

self.addEventListener("message", async (event: MessageEvent<RenderRequest>) => {
  const { documentId, generation, markdown } = event.data;
  const startedAt = performance.now();
  try {
    const result = await renderWithWasm(markdown);
    const response: RenderResponse = {
      type: "rendered",
      documentId,
      generation,
      result,
      durationMs: performance.now() - startedAt,
    };
    self.postMessage(response);
  } catch (error) {
    const response: RenderResponse = {
      type: "error",
      documentId,
      generation,
      message: error instanceof Error ? error.message : "Markdown rendering failed.",
    };
    self.postMessage(response);
  }
});
