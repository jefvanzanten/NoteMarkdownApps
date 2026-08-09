import { NextRequest, NextResponse } from "next/server";
import {
  deleteWorkspaceEntry,
  readWorkspaceFile,
  renameWorkspaceEntry,
  writeWorkspaceFile,
} from "@/lib/server/workspaces";

function getWorkspaceAndPath(request: NextRequest): { workspace: string | null; filePath: string | null } {
  return {
    workspace: request.nextUrl.searchParams.get("workspace"),
    filePath: request.nextUrl.searchParams.get("path"),
  };
}

export async function GET(request: NextRequest) {
  const { workspace, filePath } = getWorkspaceAndPath(request);

  if (!workspace || !filePath) {
    return NextResponse.json({ error: "workspace and path are required" }, { status: 400 });
  }

  try {
    const content = await readWorkspaceFile(workspace, filePath);
    return new NextResponse(content, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  const { workspace, filePath } = getWorkspaceAndPath(request);

  if (!workspace || !filePath) {
    return NextResponse.json({ error: "workspace and path are required" }, { status: 400 });
  }

  try {
    const content = await request.text();
    await writeWorkspaceFile(workspace, filePath, content);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const { workspace, filePath } = getWorkspaceAndPath(request);

  if (!workspace || !filePath) {
    return NextResponse.json({ error: "workspace and path are required" }, { status: 400 });
  }

  try {
    await deleteWorkspaceEntry(workspace, filePath);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const { workspace, filePath } = getWorkspaceAndPath(request);
  const newPath = request.nextUrl.searchParams.get("newPath");

  if (!workspace || !filePath || !newPath) {
    return NextResponse.json(
      { error: "workspace, path and newPath are required" },
      { status: 400 },
    );
  }

  try {
    await renameWorkspaceEntry(workspace, filePath, newPath);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
