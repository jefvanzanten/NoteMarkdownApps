import { redirect } from "next/navigation";
import { findWorkspaceByPath, getDefaultWorkspaceName, registerWorkspace } from "@/lib/server/workspaces";

type WorkspacePageProps = {
  searchParams?: Promise<{
    path?: string | string[];
  }>;
};

export default async function WorkspacePage({ searchParams }: WorkspacePageProps) {
  const resolvedSearchParams = await searchParams;
  const rawPath = resolvedSearchParams?.path;
  const workspacePath = Array.isArray(rawPath) ? rawPath[0] : rawPath;

  if (!workspacePath) {
    redirect("/");
  }

  const normalizedWorkspacePath = workspacePath;

  const existingWorkspace = await findWorkspaceByPath(normalizedWorkspacePath).catch(() => null);
  if (existingWorkspace) {
    redirect(`/workspaces/${existingWorkspace.slug}`);
  }

  const workspace = await registerWorkspace(
    normalizedWorkspacePath,
    getDefaultWorkspaceName(normalizedWorkspacePath),
  );
  redirect(`/workspaces/${workspace.slug}`);
}
