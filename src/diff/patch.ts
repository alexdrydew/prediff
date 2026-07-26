/**
 * Unified-diff ingestion. Accepts both portable `diff -u` output and Git's
 * extended unified format, then normalizes every file section to the
 * `diff --git` framing used by prediff's revision/search machinery.
 */

import type { DiffManifest, FileDiff, FileStatus, Hunk, ManifestFile, Side } from "../types";
import { LARGE_FILE_LINES, parseUnifiedDiff } from "../git/diff";

export interface ParsedPatch {
  raw: string;
  manifest: DiffManifest;
  files: ReadonlyMap<string, FileDiff>;
}

interface PatchSection {
  lines: string[];
  gitFramed: boolean;
}

interface ParsedSection {
  raw: string;
  file: ManifestFile;
  diff: FileDiff;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(rawInput: string, revision: number): ParsedPatch {
  const input = rawInput.replaceAll("\r\n", "\n");
  if (input.trim() === "") {
    return {
      raw: "",
      manifest: { range: "patch", revision, files: [], additions: 0, deletions: 0 },
      files: new Map(),
    };
  }

  const sections = splitPatchSections(input);
  if (sections.length === 0) {
    throw new Error("expected unified diff; generate one with `diff -u` or `git diff`");
  }

  const parsed = sections.map(parseSection);
  const files = parsed.map((entry) => entry.file).sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(parsed.map((entry) => [entry.file.path, entry.diff]));
  return {
    raw: parsed.map((entry) => entry.raw).join("\n"),
    manifest: {
      range: "patch",
      revision,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    files: byPath,
  };
}

/**
 * Best-effort content assembled only from the lines carried by the patch.
 * Unknown gaps are empty placeholders so hunk line numbers remain stable.
 * This is for comment anchoring; it must not be exposed as full file content.
 */
export function patchSideContent(
  patch: ParsedPatch,
  side: Side,
  filePath: string,
): string[] | null {
  const manifestFile = patch.manifest.files.find(
    (file) => file.path === filePath || file.old_path === filePath,
  );
  if (!manifestFile) return null;
  if (
    (side === "old" && manifestFile.status === "added") ||
    (side === "new" && manifestFile.status === "deleted")
  ) {
    return null;
  }
  const diff = patch.files.get(manifestFile.path);
  if (!diff) return null;

  let length = 0;
  for (const hunk of diff.hunks) {
    const start = side === "old" ? hunk.old_start : hunk.new_start;
    const count = side === "old" ? hunk.old_lines : hunk.new_lines;
    length = Math.max(length, start + count - 1);
  }
  const lines = Array.from({ length }, () => "");
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const number = side === "old" ? line.old_line : line.new_line;
      if (number !== null) lines[number - 1] = line.text;
    }
  }
  return lines;
}

function splitPatchSections(input: string): PatchSection[] {
  const lines = input.split("\n");
  if (lines.some((line) => line.startsWith("diff --git "))) {
    const sections: PatchSection[] = [];
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.startsWith("diff --git ")) continue;
      if (start !== -1) sections.push({ lines: lines.slice(start, i), gitFramed: true });
      start = i;
    }
    if (start !== -1) sections.push({ lines: lines.slice(start), gitFramed: true });
    return sections;
  }

  const starts: number[] = [];
  let oldRemaining = 0;
  let newRemaining = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (oldRemaining === 0 && newRemaining === 0) {
      if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) starts.push(i);
      const match = HUNK_HEADER.exec(line);
      if (match) {
        oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
        newRemaining = match[4] === undefined ? 1 : Number(match[4]);
      }
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) newRemaining = Math.max(0, newRemaining - 1);
    else if (line.startsWith("-")) oldRemaining = Math.max(0, oldRemaining - 1);
    else {
      oldRemaining = Math.max(0, oldRemaining - 1);
      newRemaining = Math.max(0, newRemaining - 1);
    }
  }

  return starts.map((start, index) => ({
    lines: lines.slice(start, starts[index + 1] ?? lines.length),
    gitFramed: false,
  }));
}

function parseSection(section: PatchSection): ParsedSection {
  const oldHeader = section.lines.findIndex((line) => line.startsWith("--- "));
  const newHeader =
    oldHeader === -1
      ? -1
      : section.lines.findIndex((line, index) => index > oldHeader && line.startsWith("+++ "));

  let oldPath: string | null = null;
  let newPath: string | null = null;
  let stripGitPrefixes = section.gitFramed;
  if (oldHeader !== -1 && newHeader !== -1) {
    oldPath = headerPath(section.lines[oldHeader]!, "--- ");
    newPath = headerPath(section.lines[newHeader]!, "+++ ");
  } else if (section.gitFramed) {
    const pair = gitHeaderPaths(section.lines[0] ?? "");
    oldPath = pair.old;
    newPath = pair.new;
  }
  const renameFrom = section.lines.find((line) => line.startsWith("rename from "));
  const renameTo = section.lines.find((line) => line.startsWith("rename to "));
  if (renameFrom !== undefined && renameTo !== undefined) {
    oldPath = metadataPath(renameFrom, "rename from ");
    newPath = metadataPath(renameTo, "rename to ");
    stripGitPrefixes = false;
  }
  if (oldPath === null && newPath === null) {
    throw new Error("invalid unified diff: file section has no usable paths");
  }

  const normalized = normalizePaths(oldPath, newPath, stripGitPrefixes);
  const path = normalized.new ?? normalized.old!;
  const status: FileStatus =
    normalized.old === null
      ? "added"
      : normalized.new === null
        ? "deleted"
        : normalized.old !== normalized.new
          ? "renamed"
          : "modified";

  const bodyStart = newHeader !== -1 ? newHeader + 1 : 1;
  const body = section.lines.slice(bodyStart);
  const prefix = [
    `diff --git a/${normalized.old ?? path} b/${normalized.new ?? path}`,
    normalized.old === null ? "--- /dev/null" : `--- a/${normalized.old}`,
    normalized.new === null ? "+++ /dev/null" : `+++ b/${normalized.new}`,
  ];
  const normalizedRaw = [...prefix, ...body].join("\n").replace(/\n+$/, "") + "\n";
  const parsed = parseUnifiedDiff(normalizedRaw);
  const counts = countChanges(parsed.hunks);
  const binary =
    parsed.binary ||
    section.lines.some(
      (line) => line.startsWith("Binary files ") || line === "GIT binary patch",
    );

  const file: ManifestFile = {
    path,
    status,
    additions: counts.additions,
    deletions: counts.deletions,
    binary,
    large: counts.additions + counts.deletions > LARGE_FILE_LINES,
  };
  if (status === "renamed" && normalized.old !== null) file.old_path = normalized.old;

  const diff: FileDiff = {
    path,
    binary,
    large: file.large,
    hunks: parsed.hunks,
  };
  if (file.old_path) diff.old_path = file.old_path;
  return { raw: normalizedRaw, file, diff };
}

function headerPath(line: string, prefix: string): string | null {
  let value = line.slice(prefix.length);
  const tab = value.indexOf("\t");
  if (tab !== -1) value = value.slice(0, tab);
  value = value.trimEnd();
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      // Preserve an unusual quoted path verbatim if it is not JSON-compatible.
    }
  }
  return value;
}

function metadataPath(line: string, prefix: string): string {
  const value = line.slice(prefix.length);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      // Preserve an unusual quoted path verbatim if it is not JSON-compatible.
    }
  }
  return value;
}

function gitHeaderPaths(line: string): { old: string | null; new: string | null } {
  const match = /^diff --git (?:a\/(.+) b\/(.+)|"a\/(.+)" "b\/(.+)")$/.exec(line);
  return {
    old: match?.[1] ?? match?.[3] ?? null,
    new: match?.[2] ?? match?.[4] ?? null,
  };
}

function normalizePaths(
  oldInput: string | null,
  newInput: string | null,
  stripPrefixes: boolean,
): { old: string | null; new: string | null } {
  const stripGitPrefix = (value: string | null, prefix: string): string | null =>
    stripPrefixes && value?.startsWith(prefix) ? value.slice(prefix.length) : value;
  let old = stripGitPrefix(oldInput, "a/");
  let next = stripGitPrefix(newInput, "b/");

  // `diff -ruN before/ after/` changes only the first root component.
  if (old !== null && next !== null && old !== next) {
    const oldSlash = old.indexOf("/");
    const newSlash = next.indexOf("/");
    if (
      oldSlash !== -1 &&
      newSlash !== -1 &&
      old.slice(oldSlash + 1) === next.slice(newSlash + 1)
    ) {
      old = old.slice(oldSlash + 1);
      next = next.slice(newSlash + 1);
    }
  }
  return { old, new: next };
}

function countChanges(hunks: Hunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions++;
      else if (line.kind === "del") deletions++;
    }
  }
  return { additions, deletions };
}
