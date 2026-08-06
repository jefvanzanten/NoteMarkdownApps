# @note/markdown-wasm

A small `pulldown-cmark` renderer compiled directly to WebAssembly. The browser wrapper uses a coarse UTF-8/JSON ABI so rendering crosses the JS/WASM boundary once per document.

Build with `pnpm --filter @note/markdown-wasm build`. The build copies the coherent renderer asset to `apps/web-app/public/notemarkdown_renderer.wasm`.
