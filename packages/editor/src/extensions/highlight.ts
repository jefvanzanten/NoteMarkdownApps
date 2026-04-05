import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, class: "md-mark" },
  { tag: tags.strong, class: "md-strong" },
  { tag: tags.emphasis, class: "md-em" },
  { tag: tags.strikethrough, class: "md-strike" },
  { tag: tags.monospace, class: "md-code" },
  { tag: tags.link, class: "md-link" },
  { tag: tags.url, class: "md-url" },
  { tag: tags.keyword, color: "#c084fc" },
  { tag: tags.typeName, color: "#fde68a" },
  { tag: tags.string, color: "#86efac" },
  { tag: tags.number, color: "#fb923c" },
  { tag: tags.comment, color: "#475569", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#475569", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#475569", fontStyle: "italic" },
  { tag: tags.operator, color: "#7dd3fc" },
  { tag: tags.punctuation, color: "#94a3b8" },
  { tag: tags.propertyName, color: "#f9a8d4" },
  { tag: tags.variableName, color: "#e2e8f0" },
  { tag: tags.function(tags.variableName), color: "#93c5fd" },
  { tag: tags.className, color: "#fde68a" },
  { tag: tags.definition(tags.variableName), color: "#e2e8f0" },
  { tag: tags.attributeName, color: "#f9a8d4" },
  { tag: tags.bool, color: "#fb923c" },
]);
