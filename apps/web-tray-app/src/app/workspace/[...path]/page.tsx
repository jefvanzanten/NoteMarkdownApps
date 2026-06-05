import { redirect } from "next/navigation";
import { resolveWorkspacePath } from "@/lib/pathResolver";

interface WorkspacePageProps {
  params: Promise<{ path: string[] }>;
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { path } = await params;
  const workspacePath = resolveWorkspacePath(path);
  redirect(`/workspace?path=${encodeURIComponent(workspacePath)}`);
}
