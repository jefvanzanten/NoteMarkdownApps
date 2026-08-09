import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";

export async function POST(request: NextRequest) {
  let body: { path?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { path: filePath, content } = body;
  if (!filePath || content === undefined) {
    return NextResponse.json({ error: "path and content are required" }, { status: 400 });
  }

  try {
    await fs.writeFile(filePath, content, "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
