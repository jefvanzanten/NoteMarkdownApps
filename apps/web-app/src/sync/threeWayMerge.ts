export type ThreeWayMergeResult =
  | { kind: "unchanged" | "local" | "remote" | "merged"; content: string }
  | { kind: "conflict" };

interface LineChange {
  start: number;
  end: number;
  replacement: string[];
}

/**
 * Finds one conservative contiguous line change from a base to a variant.
 * @param base Base lines.
 * @param variant Changed lines.
 * @returns Minimal contiguous replacement range.
 */
function findLineChange(base: string[], variant: string[]): LineChange {
  let start = 0;
  while (start < base.length && start < variant.length && base[start] === variant[start]) start += 1;
  let suffix = 0;
  while (
    suffix < base.length - start
    && suffix < variant.length - start
    && base[base.length - suffix - 1] === variant[variant.length - suffix - 1]
  ) suffix += 1;
  return {
    start,
    end: base.length - suffix,
    replacement: variant.slice(start, variant.length - suffix),
  };
}

/**
 * Determines whether two base-relative replacements can be applied independently.
 * @param left First replacement.
 * @param right Second replacement.
 * @returns Whether neither replacement consumes the other's base range.
 */
function changesAreIndependent(left: LineChange, right: LineChange): boolean {
  if (left.start === right.start && left.end === right.end) return false;
  return left.end <= right.start || right.end <= left.start;
}

/**
 * Applies independent replacements from the end of the document backwards.
 * @param base Base lines.
 * @param changes Independent replacements.
 * @returns Merged lines.
 */
function applyChanges(base: string[], changes: LineChange[]): string[] {
  const result = [...base];
  for (const change of [...changes].sort((left, right) => right.start - left.start)) {
    result.splice(change.start, change.end - change.start, ...change.replacement);
  }
  return result;
}

/**
 * Conservatively merges non-overlapping local and remote line changes.
 * Complex or overlapping edits remain explicit conflicts instead of guessing.
 * @param base Common confirmed provider content.
 * @param local Latest durable local content.
 * @param remote Newly observed provider content.
 * @returns Converged content or an explicit conflict.
 */
export function threeWayMerge(base: string, local: string, remote: string): ThreeWayMergeResult {
  if (local === remote) return { kind: "unchanged", content: local };
  if (local === base) return { kind: "remote", content: remote };
  if (remote === base) return { kind: "local", content: local };

  const baseLines = base.split("\n");
  const localChange = findLineChange(baseLines, local.split("\n"));
  const remoteChange = findLineChange(baseLines, remote.split("\n"));
  if (!changesAreIndependent(localChange, remoteChange)) return { kind: "conflict" };

  return { kind: "merged", content: applyChanges(baseLines, [localChange, remoteChange]).join("\n") };
}
