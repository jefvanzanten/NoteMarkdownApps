import { redirect } from "next/navigation";
import { WorkspaceEditor } from "@/components/WorkspaceEditor";

type WorkspacePageProps = {
  searchParams?: {
    path?: string | string[];
  };
};

export default function WorkspacePage({ searchParams }: WorkspacePageProps) {
  const rawPath = searchParams?.path;
  const workspacePath = Array.isArray(rawPath) ? rawPath[0] : rawPath;

  if (!workspacePath) {
    redirect("/");
  }

  return <WorkspaceEditor workspacePath={workspacePath} />;
}
