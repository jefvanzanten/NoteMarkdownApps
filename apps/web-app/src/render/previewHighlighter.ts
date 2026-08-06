const keywordSets: Record<string, Set<string>> = {
  javascript: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "new", "import", "export", "async", "await", "true", "false", "null"]),
  js: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "new", "import", "export", "async", "await", "true", "false", "null"]),
  typescript: new Set(["const", "let", "function", "return", "interface", "type", "class", "implements", "extends", "import", "export", "async", "await", "true", "false", "null"]),
  ts: new Set(["const", "let", "function", "return", "interface", "type", "class", "implements", "extends", "import", "export", "async", "await", "true", "false", "null"]),
  rust: new Set(["fn", "let", "mut", "pub", "impl", "struct", "enum", "match", "use", "mod", "async", "await", "true", "false", "self", "Self"]),
  json: new Set(["true", "false", "null"]),
};

/**
 * Applies lightweight, lazy keyword highlighting to rendered code blocks.
 * @param container Preview container containing rendered code nodes.
 * @param languages Languages reported by the Rust renderer.
 * @returns Nothing after highlighting supported blocks.
 */
export function highlightCodeBlocks(container: HTMLElement, languages: readonly string[]): void {
  const enabled = new Set(languages.map((language) => language.toLowerCase()));
  for (const code of container.querySelectorAll("pre code")) {
    const languageClass = Array.from(code.classList).find((name) => name.startsWith("language-"));
    const language = languageClass?.slice("language-".length).toLowerCase() ?? "";
    if (!enabled.has(language)) continue;
    const keywords = keywordSets[language];
    if (!keywords) continue;
    const fragment = document.createDocumentFragment();
    for (const token of (code.textContent ?? "").split(/(\b[A-Za-z_$][\w$]*\b)/)) {
      if (keywords.has(token)) {
        const span = document.createElement("span");
        span.className = "syntaxKeyword";
        span.textContent = token;
        fragment.append(span);
      } else {
        fragment.append(document.createTextNode(token));
      }
    }
    code.replaceChildren(fragment);
  }
}
