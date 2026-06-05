import { NextRequest, NextResponse } from "next/server";
import { listDirectories } from "@/lib/server/workspaces";

export async function GET(request: NextRequest) {
  const dirPath = request.nextUrl.searchParams.get("path") ?? undefined;

  try {
    const listing = await listDirectories(dirPath);
    return NextResponse.json(listing);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
