import { useEffect, useRef, useState } from "react";
import { resolveWorkspaceTarget, type WorkspaceProvider } from "@note/workspace-core";
import type { MarkdownRenderResult } from "@note/markdown-wasm";
import { renderMarkdown } from "../render/renderClient";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./MarkdownPreview.module.css";

interface MarkdownPreviewProps {
  documentPath: string;
  markdown: string;
  provider: WorkspaceProvider;
  locale: Locale;
  onOpenDocument: (path: string) => void;
}

/**
 * Renders safe Rust/WASM preview output and resolves provider-local assets.
 * @param props Active document, provider, locale, and navigation callback.
 * @returns The interactive Markdown preview.
 */
export function MarkdownPreview({
  documentPath,
  markdown,
  provider,
  locale,
  onOpenDocument,
}: MarkdownPreviewProps) {
  const [result, setResult] = useState<MarkdownRenderResult | null>(null);
  const [error, setError] = useState(false);
  const [isRendering, setIsRendering] = useState(true);
  const generationRef = useRef(0);
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    setIsRendering(true);
    setError(false);
    const delay = markdown.length > 1_000_000 ? 280 : markdown.length > 100_000 ? 160 : 70;
    const timeout = window.setTimeout(() => {
      void renderMarkdown(documentPath, generation, markdown)
        .then((nextResult) => {
          if (generation !== generationRef.current) return;
          setResult(nextResult);
          setIsRendering(false);
        })
        .catch(() => {
          if (generation !== generationRef.current) return;
          setError(true);
          setIsRendering(false);
        });
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [documentPath, markdown]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !result) return;
    const objectUrls: string[] = [];
    const removers: Array<() => void> = [];
    let cancelled = false;

    if (result.codeLanguages.length > 0) {
      void import("../render/previewHighlighter").then(({ highlightCodeBlocks }) => {
        if (!cancelled) highlightCodeBlocks(container, result.codeLanguages);
      });
    }

    for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = anchor.getAttribute("href") ?? "";
      if (/^https?:|^mailto:/i.test(href)) {
        anchor.target = "_blank";
        anchor.rel = "noreferrer noopener";
        continue;
      }
      if (href.startsWith("#")) continue;
      const targetPath = resolveWorkspaceTarget(documentPath, href);
      const listener = (event: MouseEvent) => {
        event.preventDefault();
        if (targetPath?.toLowerCase().endsWith(".md")) onOpenDocument(targetPath);
      };
      anchor.addEventListener("click", listener);
      removers.push(() => anchor.removeEventListener("click", listener));
    }

    for (const image of container.querySelectorAll<HTMLImageElement>("img[src]")) {
      const authoredSource = image.getAttribute("src") ?? "";
      const targetPath = resolveWorkspaceTarget(documentPath, authoredSource);
      if (!targetPath) {
        image.removeAttribute("src");
        continue;
      }
      void provider.readBinary(targetPath).then(({ blob }) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.push(objectUrl);
        image.src = objectUrl;
      }).catch(() => image.classList.add(styles.brokenImage));
    }

    return () => {
      cancelled = true;
      for (const remove of removers) remove();
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    };
  }, [documentPath, onOpenDocument, provider, result]);

  if (error) return <div className={styles.message} role="alert">{translate(locale, "renderError")}</div>;

  return (
    <section
      ref={containerRef}
      className={styles.preview}
      aria-busy={isRendering}
      aria-label={translate(locale, "preview")}
    >
      {isRendering && !result ? <div className={styles.message}>{translate(locale, "rendering")}</div> : null}
      {result ? <div dangerouslySetInnerHTML={{ __html: result.html }} /> : null}
    </section>
  );
}
