export type DirectoryBrowserEntryKind = "drive" | "directory" | "special";

export type DirectoryBrowserEntry = {
  kind: DirectoryBrowserEntryKind;
  label: string;
  path: string;
};

export type DirectoryBreadcrumb = {
  label: string;
  path: string;
};

export type DirectoryListing = {
  current: string;
  parent: string | null;
  breadcrumbs: DirectoryBreadcrumb[];
  locations: DirectoryBrowserEntry[];
  directories: DirectoryBrowserEntry[];
};
