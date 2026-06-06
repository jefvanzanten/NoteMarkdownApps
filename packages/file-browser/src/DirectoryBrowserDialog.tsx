"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { DirectoryBrowserEntry, DirectoryListing } from "./types";

export type DirectoryBrowserDialogProps = {
  confirmLabel?: string;
  isOpen: boolean;
  loadListing: (path?: string) => Promise<DirectoryListing>;
  onClose: () => void;
  onSelect: (path: string) => void;
  title?: string;
};

export function DirectoryBrowserDialog({
  confirmLabel = "Use This Folder",
  isOpen,
  loadListing,
  onClose,
  onSelect,
  title = "Browse Folders",
}: DirectoryBrowserDialogProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    void navigate();
  }, [isOpen]);

  async function navigate(targetPath?: string) {
    setLoading(true);
    setError("");

    try {
      const nextListing = await loadListing(targetPath);
      setListing(nextListing);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const locations = useMemo(() => listing?.locations ?? [], [listing]);
  const directories = useMemo(() => listing?.directories ?? [], [listing]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle}>
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <div style={headerCopyStyle}>
            <h2 style={titleStyle}>{title}</h2>
            <p style={pathStyle}>{listing?.current ?? "Loading..."}</p>
          </div>
          <button type="button" style={closeButtonStyle} onClick={onClose}>
            x
          </button>
        </div>

        <div style={toolbarStyle}>
          <button
            type="button"
            style={secondaryButtonStyle}
            disabled={!listing?.parent || loading}
            onClick={() => void navigate(listing?.parent ?? undefined)}
          >
            Up
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!listing || loading}
            onClick={() => listing && onSelect(listing.current)}
          >
            {confirmLabel}
          </button>
        </div>

        <div style={breadcrumbsStyle}>
          {listing?.breadcrumbs.map((crumb) => (
            <button
              key={crumb.path}
              type="button"
              style={breadcrumbButtonStyle}
              onClick={() => void navigate(crumb.path)}
            >
              {crumb.label}
            </button>
          ))}
        </div>

        <div style={bodyStyle}>
          <section style={locationsPaneStyle}>
            <p style={sectionLabelStyle}>Locations</p>
            <div style={locationsListStyle}>
              {locations.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  style={locationButtonStyle}
                  onClick={() => void navigate(entry.path)}
                >
                  <span style={entryIconStyle}>{entry.kind === "drive" ? "D" : "F"}</span>
                  <span style={entryLabelStyle}>{entry.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section style={directoriesPaneStyle}>
            <p style={sectionLabelStyle}>Folders</p>
            <div style={directoriesListStyle}>
              {loading && <div style={messageStyle}>Loading folders...</div>}
              {!loading && error && <div style={errorStyle}>{error}</div>}
              {!loading && !error && directories.length === 0 && (
                <div style={messageStyle}>No subdirectories found.</div>
              )}
              {!loading &&
                !error &&
                directories.map((entry) => (
                  <DirectoryRow
                    entry={entry}
                    key={entry.path}
                    onOpen={(path) => void navigate(path)}
                    onSelect={onSelect}
                  />
                ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function DirectoryRow({
  entry,
  onOpen,
  onSelect,
}: {
  entry: DirectoryBrowserEntry;
  onOpen: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <div style={rowStyle}>
      <button type="button" style={rowOpenButtonStyle} onClick={() => onOpen(entry.path)}>
        <span style={entryIconStyle}>F</span>
        <span style={entryLabelStyle}>{entry.label}</span>
      </button>
      <button type="button" style={rowSelectButtonStyle} onClick={() => onSelect(entry.path)}>
        Select
      </button>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(18, 18, 18, 0.74)",
  zIndex: 1300,
};

const dialogStyle: CSSProperties = {
  width: "min(980px, calc(100vw - 36px))",
  maxHeight: "min(760px, calc(100vh - 36px))",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  background: "#2a2a2a",
  border: "1px solid #3a3a3a",
  borderRadius: "10px",
  padding: "18px",
  color: "#f3f3f3",
  boxShadow: "0 26px 80px rgba(0, 0, 0, 0.38)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "12px",
};

const headerCopyStyle: CSSProperties = {
  minWidth: 0,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  fontWeight: 600,
};

const pathStyle: CSSProperties = {
  margin: "6px 0 0",
  color: "#b6b6b6",
  fontSize: "0.8rem",
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
  wordBreak: "break-all",
};

const closeButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  border: "none",
  borderRadius: "6px",
  background: "#353535",
  color: "#d0d0d0",
  cursor: "pointer",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
};

const primaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: "6px",
  padding: "9px 12px",
  background: "#3a3a3a",
  color: "#f3f3f3",
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  border: "1px solid #4b4b4b",
  borderRadius: "6px",
  padding: "9px 12px",
  background: "#333",
  color: "#f3f3f3",
  cursor: "pointer",
};

const breadcrumbsStyle: CSSProperties = {
  display: "flex",
  gap: "6px",
  flexWrap: "wrap",
  padding: "8px",
  borderRadius: "8px",
  background: "#232323",
  border: "1px solid #373737",
};

const breadcrumbButtonStyle: CSSProperties = {
  border: "1px solid #454545",
  borderRadius: "6px",
  background: "#2e2e2e",
  color: "#ddd",
  cursor: "pointer",
  padding: "5px 8px",
  fontSize: "0.8rem",
};

const bodyStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "240px 1fr",
  gap: "12px",
  minHeight: 0,
  flex: 1,
};

const locationsPaneStyle: CSSProperties = {
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const directoriesPaneStyle: CSSProperties = {
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const sectionLabelStyle: CSSProperties = {
  margin: 0,
  color: "#9f9f9f",
  fontSize: "0.74rem",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const locationsListStyle: CSSProperties = {
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "8px",
  background: "#1f1f1f",
  border: "1px solid #373737",
  borderRadius: "8px",
};

const directoriesListStyle: CSSProperties = {
  minHeight: 280,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "8px",
  background: "#1f1f1f",
  border: "1px solid #373737",
  borderRadius: "8px",
};

const locationButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  border: "none",
  borderRadius: "6px",
  background: "#2b2b2b",
  color: "#ececec",
  cursor: "pointer",
  padding: "8px 10px",
  textAlign: "left",
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  alignItems: "center",
};

const rowOpenButtonStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  gap: "8px",
  minWidth: 0,
  border: "none",
  borderRadius: "6px",
  background: "#2b2b2b",
  color: "#ececec",
  cursor: "pointer",
  padding: "9px 10px",
  textAlign: "left",
};

const rowSelectButtonStyle: CSSProperties = {
  border: "1px solid #494949",
  borderRadius: "6px",
  background: "#303030",
  color: "#ddd",
  cursor: "pointer",
  padding: "9px 10px",
};

const entryIconStyle: CSSProperties = {
  width: 18,
  flex: "0 0 18px",
  color: "#d0a54f",
  fontSize: "0.72rem",
  fontWeight: 700,
};

const entryLabelStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const messageStyle: CSSProperties = {
  color: "#9f9f9f",
  padding: "14px 10px",
  fontSize: "0.85rem",
};

const errorStyle: CSSProperties = {
  color: "#f1a7b2",
  padding: "14px 10px",
  fontSize: "0.85rem",
};
