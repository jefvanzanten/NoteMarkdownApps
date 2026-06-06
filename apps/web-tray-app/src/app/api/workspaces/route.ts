import { NextRequest, NextResponse } from "next/server";
import { registerWorkspace } from "@/lib/server/workspaces";

export async function POST(request: NextRequest) {
  let body: { path?: string; name?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const workspacePath = body.path?.trim();
  const workspaceName = body.name?.trim();

  if (!workspacePath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    const workspace = await registerWorkspace(workspacePath, workspaceName ?? "");
    return NextResponse.json(workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
