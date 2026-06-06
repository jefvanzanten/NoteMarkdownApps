import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { WorkspaceEditor } from "@/components/WorkspaceEditor";
import { getWorkspaceBySlug } from "@/lib/server/workspaces";

interface WorkspacePageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: WorkspacePageProps): Promise<Metadata> {
  const { slug } = await params;

  try {
    const workspace = await getWorkspaceBySlug(slug);
    return {
      title: `NoteMarkdown - ${workspace.name}`,
    };
  } catch {
    return {
      title: "NoteMarkdown",
    };
  }
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { slug } = await params;

  try {
    const workspace = await getWorkspaceBySlug(slug);
    return (
      <WorkspaceEditor
        workspaceName={workspace.name}
        workspacePath={workspace.path}
        workspaceSlug={workspace.slug}
      />
    );
  } catch {
    redirect("/");
  }
}
