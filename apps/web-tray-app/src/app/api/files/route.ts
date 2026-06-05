import { NextRequest, NextResponse } from "next/server";
import { listWorkspaceFiles } from "@/lib/server/workspaces";

export async function GET(request: NextRequest) {
  const workspacePath = request.nextUrl.searchParams.get("workspace");

  if (!workspacePath) {
    return NextResponse.json({ error: "workspace is required" }, { status: 400 });
  }

  try {
    const files = await listWorkspaceFiles(workspacePath);
    return NextResponse.json(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
