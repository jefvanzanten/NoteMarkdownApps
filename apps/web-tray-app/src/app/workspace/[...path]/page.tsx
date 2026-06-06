import { redirect } from "next/navigation";
import { resolveWorkspacePath } from "@/lib/pathResolver";
import {
  findWorkspaceByPath,
  getDefaultWorkspaceName,
  getWorkspaceBySlug,
  registerWorkspace,
} from "@/lib/server/workspaces";

interface WorkspacePageProps {
  params: Promise<{ path: string[] }>;
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { path } = await params;

  if (path.length === 1) {
    try {
      const workspace = await getWorkspaceBySlug(path[0]);
      redirect(`/workspaces/${workspace.slug}`);
    } catch {
      // Fall through to legacy path resolution.
    }
  }

  const workspacePath = resolveWorkspacePath(path);
  const existingWorkspace = await findWorkspaceByPath(workspacePath).catch(() => null);
  if (existingWorkspace) {
    redirect(`/workspaces/${existingWorkspace.slug}`);
  }

  const workspace = await registerWorkspace(workspacePath, getDefaultWorkspaceName(workspacePath));
  redirect(`/workspaces/${workspace.slug}`);
}
