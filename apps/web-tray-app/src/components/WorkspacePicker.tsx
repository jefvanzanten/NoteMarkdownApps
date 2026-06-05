"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FolderBrowser } from "@/components/FolderBrowser";

type RecentWorkspace = {
  path: string;
  name: string;
};

async function fetchRecents(): Promise<RecentWorkspace[]> {
  const response = await fetch("/api/workspaces/recent");
  if (!response.ok) return [];
  return response.json() as Promise<RecentWorkspace[]>;
}

async function registerWorkspace(path: string, name: string): Promise<void> {
  const response = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, name }),
  });

  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? "Failed to open workspace");
  }
}

function defaultWorkspaceName(folderPath: string): string {
  return folderPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
}

export function WorkspacePicker() {
  const router = useRouter();
  const [folderPath, setFolderPath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  const [showBrowser, setShowBrowser] = useState(false);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void loadRecents();
  }, []);

  async function loadRecents() {
    const recents = await fetchRecents();
    setRecentWorkspaces(recents);
  }

  function navigateToWorkspace(path: string) {
    startTransition(() => {
      router.push(`/workspace?path=${encodeURIComponent(path)}`);
    });
  }

  async function openWorkspace(path: string, name: string) {
    const trimmedPath = path.trim();
    const trimmedName = name.trim() || defaultWorkspaceName(trimmedPath);

    if (!trimmedPath) {
      setError("Enter a folder path.");
      return;
    }

    setError("");

    try {
      await registerWorkspace(trimmedPath, trimmedName);
      navigateToWorkspace(trimmedPath);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unknown error");
    }
  }

  return (
    <div style={wrapperStyle}>
      <div style={heroStyle} />
      <div style={cardStyle}>
        <div>
          <p style={eyebrowStyle}>Electron Workspace Mode</p>
          <h1 style={headingStyle}>Open a notes folder</h1>
          <p style={bodyStyle}>
            The React desktop app now follows the Tauri workspace flow: choose a
            folder, reopen recents, and manage markdown files directly from the tray app.
          </p>
        </div>

        <div style={fieldStackStyle}>
          <label style={labelStyle} htmlFor="workspace-path">
            Folder path
          </label>
          <div style={pathRowStyle}>
            <input
              id="workspace-path"
              type="text"
              value={folderPath}
              onChange={(event) => {
                const nextPath = event.target.value;
                setFolderPath(nextPath);
                if (!workspaceName) setWorkspaceName(defaultWorkspaceName(nextPath));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void openWorkspace(folderPath, workspaceName);
                }
              }}
              placeholder="C:\\Users\\you\\Documents\\Notes"
              style={inputStyle}
            />
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => setShowBrowser(true)}
              disabled={isPending}
            >
              Browse
            </button>
          </div>
        </div>

        <div style={fieldStackStyle}>
          <label style={labelStyle} htmlFor="workspace-name">
            Workspace name
          </label>
          <input
            id="workspace-name"
            type="text"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="My notes"
            style={inputStyle}
          />
        </div>

        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => void openWorkspace(folderPath, workspaceName)}
          disabled={isPending}
        >
          {isPending ? "Opening..." : "Open workspace"}
        </button>

        {recentWorkspaces.length > 0 && (
          <div style={recentsStyle}>
            <p style={recentsLabelStyle}>Recent</p>
            {recentWorkspaces.map((recent) => (
              <button
                key={recent.path}
                type="button"
                style={recentButtonStyle}
                onClick={() => {
                  setFolderPath(recent.path);
                  setWorkspaceName(recent.name);
                  void openWorkspace(recent.path, recent.name);
                }}
                disabled={isPending}
              >
                <span style={recentNameStyle}>{recent.name}</span>
                <span style={recentPathStyle}>{recent.path}</span>
              </button>
            ))}
          </div>
        )}

        {error && <p style={errorStyle}>{error}</p>}
      </div>

      {showBrowser && (
        <FolderBrowser
          onClose={() => setShowBrowser(false)}
          onSelect={(path) => {
            setFolderPath(path);
            if (!workspaceName) setWorkspaceName(defaultWorkspaceName(path));
            setShowBrowser(false);
          }}
        />
      )}
    </div>
  );
}

const wrapperStyle = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "28px",
  position: "relative",
  overflow: "hidden",
  background:
    "radial-gradient(circle at top left, rgba(79, 131, 204, 0.26), transparent 32%), linear-gradient(160deg, #08101b, #0e1726 52%, #151d2f)",
} as const;

const heroStyle = {
  position: "absolute",
  inset: "auto auto -120px -120px",
  width: 360,
  height: 360,
  borderRadius: "50%",
  background: "radial-gradient(circle, rgba(255, 194, 102, 0.22), transparent 70%)",
  filter: "blur(10px)",
} as const;

const cardStyle = {
  position: "relative",
  zIndex: 1,
  width: "min(560px, 100%)",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  padding: "28px",
  borderRadius: "18px",
  border: "1px solid rgba(129, 158, 198, 0.22)",
  background: "rgba(8, 14, 24, 0.85)",
  boxShadow: "0 28px 80px rgba(0, 0, 0, 0.32)",
  backdropFilter: "blur(14px)",
} as const;

const eyebrowStyle = {
  margin: 0,
  fontSize: "0.78rem",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "#89a3c8",
} as const;

const headingStyle = {
  margin: "8px 0 0",
  fontSize: "2rem",
  lineHeight: 1.05,
  color: "#f8fbff",
} as const;

const bodyStyle = {
  margin: "12px 0 0",
  fontSize: "0.96rem",
  lineHeight: 1.55,
  color: "#9db0cb",
} as const;

const fieldStackStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
} as const;

const labelStyle = {
  fontSize: "0.8rem",
  color: "#8ea2c0",
} as const;

const pathRowStyle = {
  display: "flex",
  gap: "10px",
} as const;

const inputStyle = {
  width: "100%",
  border: "1px solid #2a3a52",
  borderRadius: "10px",
  background: "#0c1422",
  color: "#e7eef8",
  padding: "11px 12px",
  fontSize: "0.95rem",
  outline: "none",
} as const;

const primaryButtonStyle = {
  border: "none",
  borderRadius: "10px",
  padding: "12px 14px",
  background: "linear-gradient(135deg, #4f83cc, #6a9be0)",
  color: "#fff",
  cursor: "pointer",
  fontSize: "0.94rem",
  fontWeight: 600,
} as const;

const secondaryButtonStyle = {
  border: "1px solid #2a3a52",
  borderRadius: "10px",
  padding: "11px 14px",
  background: "#162233",
  color: "#d8e1ee",
  cursor: "pointer",
  fontSize: "0.92rem",
  whiteSpace: "nowrap",
} as const;

const recentsStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  paddingTop: "10px",
  borderTop: "1px solid rgba(129, 158, 198, 0.16)",
} as const;

const recentsLabelStyle = {
  margin: 0,
  fontSize: "0.76rem",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "#6d83a6",
} as const;

const recentButtonStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "2px",
  border: "1px solid rgba(129, 158, 198, 0.14)",
  borderRadius: "10px",
  background: "#0d1625",
  color: "#e7eef8",
  cursor: "pointer",
  textAlign: "left",
  padding: "10px 12px",
} as const;

const recentNameStyle = {
  fontSize: "0.92rem",
  fontWeight: 500,
} as const;

const recentPathStyle = {
  fontSize: "0.76rem",
  color: "#7e91ae",
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  wordBreak: "break-all",
} as const;

const errorStyle = {
  margin: 0,
  color: "#fda4af",
  fontSize: "0.88rem",
} as const;
