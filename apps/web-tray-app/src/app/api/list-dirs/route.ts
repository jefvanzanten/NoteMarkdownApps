import { NextRequest, NextResponse } from "next/server";
import { listDirectoryBrowser } from "@note/file-browser/server";

export async function GET(request: NextRequest) {
  const dirPath = request.nextUrl.searchParams.get("path") ?? undefined;

  try {
    const listing = await listDirectoryBrowser(dirPath);
    return NextResponse.json(listing);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
