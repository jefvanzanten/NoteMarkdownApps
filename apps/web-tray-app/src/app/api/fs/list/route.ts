import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { resolveWorkspacePath } from "@/lib/pathResolver";

export async function GET(request: NextRequest) {
  const rawPath = request.nextUrl.searchParams.get("path") ?? "";
  const segments = rawPath.split("/").filter(Boolean);

  try {
    const dirPath = resolveWorkspacePath(segments);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const items = entries
      .filter((e) => (e.isFile() && e.name.endsWith(".md")) || e.isDirectory())
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
        path: path.join(dirPath, e.name),
      }));

    return NextResponse.json({ items, resolvedPath: dirPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
