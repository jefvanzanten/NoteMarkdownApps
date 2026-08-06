export interface RenderHeading {
  level: number;
  text: string;
  id: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface MarkdownRenderResult {
  html: string;
  headings: RenderHeading[];
  links: string[];
  images: string[];
  codeLanguages: string[];
}

export interface RenderRequest {
  documentId: string;
  generation: number;
  markdown: string;
}

export interface RenderSuccessResponse {
  type: "rendered";
  documentId: string;
  generation: number;
  result: MarkdownRenderResult;
  durationMs: number;
}

export interface RenderErrorResponse {
  type: "error";
  documentId: string;
  generation: number;
  message: string;
}

export type RenderResponse = RenderSuccessResponse | RenderErrorResponse;
