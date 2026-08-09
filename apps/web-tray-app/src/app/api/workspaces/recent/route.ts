import { NextResponse } from "next/server";
import { listRecentWorkspaces } from "@/lib/server/workspaces";

export async function GET() {
  const recents = await listRecentWorkspaces();
  return NextResponse.json(recents);
}
