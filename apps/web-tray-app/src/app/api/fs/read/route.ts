import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get("file");
  if (!filePath) {
    return NextResponse.json({ error: "file parameter is required" }, { status: 400 });
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return NextResponse.json({ content, path: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
