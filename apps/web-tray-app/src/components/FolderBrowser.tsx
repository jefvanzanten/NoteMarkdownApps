"use client";

import { useEffect, useState } from "react";

type DirEntry = {
  name: string;
  path: string;
};

type DirListing = {
  current: string;
  parent: string | null;
  dirs: DirEntry[];
};

type FolderBrowserProps = {
  onClose: () => void;
  onSelect: (path: string) => void;
};

async function listDirs(dirPath?: string): Promise<DirListing> {
  const url = dirPath
    ? `/api/list-dirs?path=${encodeURIComponent(dirPath)}`
    : "/api/list-dirs";
  const response = await fetch(url);
  if (!response.ok) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? "Failed to list directories");
  }
  return response.json() as Promise<DirListing>;
}

export function FolderBrowser({ onClose, onSelect }: FolderBrowserProps) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadDirectory();
  }, []);

  async function loadDirectory(dirPath?: string) {
    setLoading(true);
    setError("");
    try {
      const nextListing = await listDirs(dirPath);
      setListing(nextListing);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <div>
            <h2 style={titleStyle}>Browse Folders</h2>
            <p style={subtitleStyle}>{listing?.current ?? "Loading..."}</p>
          </div>
          <button type="button" style={closeButtonStyle} onClick={onClose}>
            x
          </button>
        </div>

        <div style={toolbarStyle}>
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={() => void loadDirectory(listing?.parent ?? undefined)}
            disabled={!listing?.parent || loading}
          >
            Up
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => listing && onSelect(listing.current)}
            disabled={!listing || loading}
          >
            Use This Folder
          </button>
        </div>

        <div style={listStyle}>
          {loading && <div style={emptyStyle}>Loading directories...</div>}
          {!loading && error && <div style={errorStyle}>{error}</div>}
          {!loading && !error && listing?.dirs.length === 0 && (
            <div style={emptyStyle}>No subdirectories found.</div>
          )}
          {!loading &&
            !error &&
            listing?.dirs.map((dir) => (
              <button
                key={dir.path}
                type="button"
                style={dirButtonStyle}
                onClick={() => void loadDirectory(dir.path)}
              >
                <span style={dirNameStyle}>{dir.name}</span>
                <span style={dirPathStyle}>{dir.path}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(20, 20, 20, 0.72)",
  zIndex: 1000,
} as const;

const cardStyle = {
  width: "min(760px, calc(100vw - 32px))",
  maxHeight: "min(720px, calc(100vh - 32px))",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  background: "var(--panel-bg)",
  border: "1px solid var(--panel-border)",
  borderRadius: "10px",
  padding: "18px",
  boxShadow: "0 24px 80px rgba(0, 0, 0, 0.35)",
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "12px",
} as const;

const titleStyle = {
  margin: 0,
  fontSize: "1rem",
  fontWeight: 600,
  color: "var(--text-main)",
} as const;

const subtitleStyle = {
  margin: "6px 0 0",
  fontSize: "0.8rem",
  color: "var(--text-muted)",
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  wordBreak: "break-all",
} as const;

const toolbarStyle = {
  display: "flex",
  gap: "8px",
} as const;

const listStyle = {
  minHeight: 220,
  overflowY: "auto",
  border: "1px solid var(--panel-border)",
  borderRadius: "8px",
  background: "var(--app-bg)",
  padding: "8px",
} as const;

const dirButtonStyle = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "2px",
  border: "1px solid transparent",
  borderRadius: "6px",
  padding: "10px 12px",
  background: "transparent",
  color: "var(--text-main)",
  cursor: "pointer",
  textAlign: "left",
} as const;

const dirNameStyle = {
  fontSize: "0.92rem",
  fontWeight: 500,
} as const;

const dirPathStyle = {
  fontSize: "0.76rem",
  color: "var(--text-dim)",
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  wordBreak: "break-all",
} as const;

const closeButtonStyle = {
  border: "none",
  borderRadius: "6px",
  width: 28,
  height: 28,
  background: "#333",
  color: "var(--text-muted)",
  cursor: "pointer",
} as const;

const primaryButtonStyle = {
  border: "none",
  borderRadius: "6px",
  padding: "9px 12px",
  background: "#3a3a3a",
  color: "var(--text-main)",
  cursor: "pointer",
} as const;

const secondaryButtonStyle = {
  border: "1px solid var(--panel-border-strong)",
  borderRadius: "6px",
  padding: "9px 12px",
  background: "#333",
  color: "var(--text-main)",
  cursor: "pointer",
} as const;

const emptyStyle = {
  padding: "18px 12px",
  color: "var(--text-dim)",
  fontSize: "0.86rem",
} as const;

const errorStyle = {
  padding: "18px 12px",
  color: "#fda4af",
  fontSize: "0.86rem",
} as const;
