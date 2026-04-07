import { WorkspaceEditor } from "@/components/WorkspaceEditor";

interface WorkspacePageProps {
  params: Promise<{ path: string[] }>;
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { path } = await params;
  return <WorkspaceEditor pathSegments={path} />;
}
