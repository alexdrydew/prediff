/**
 * Diff engine: shells out to git, produces (a) a fast manifest and
 * (b) per-file structured hunks on demand. See ARCHITECTURE.md §3.
 */

import path from "node:path";
import { git, revParse } from "./exec";
import type {
  DiffManifest,
  FileDiff,
  FileStatus,
  Hunk,
  HunkLine,
  ManifestFile,
  RangeSpec,
  Side,
} from "../types";

/** git's well-known empty tree object; lets us diff against "nothing". */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Per-file line-count threshold above which hunks are withheld by default. */
export const LARGE_FILE_LINES = 5_000;

/** Detect renames, keep output deterministic. */
const DIFF_FLAGS = ["--no-color", "-M"] as const;

export interface ResolvedRange {
  spec: RangeSpec;
  /** Args placed after `git diff` (before `--`). */
  diffArgs: string[];
  /** Commit-ish content on the old side lives at (EMPTY_TREE for "nothing"). */
  baseRef: string;
  /**
   * Where content on the new side lives:
   *  - null        → working tree
   *  - ":index"    → the index (git show :<path>)
   *  - commit sha  → that commit
   */
  targetRef: string | null;
}

/** Normalize a user-supplied range spec into git diff arguments. */
export async function resolveRange(repo: string, spec: RangeSpec): Promise<ResolvedRange> {
  const head = await revParse(repo, "HEAD");

  if (spec === "working") {
    const base = head ?? EMPTY_TREE;
    return { spec, diffArgs: [base], baseRef: base, targetRef: null };
  }
  if (spec === "staged") {
    const base = head ?? EMPTY_TREE;
    return { spec, diffArgs: ["--cached", base], baseRef: base, targetRef: ":index" };
  }

  const dots = spec.includes("...") ? "..." : spec.includes("..") ? ".." : null;
  if (dots) {
    const [a, b = "HEAD"] = spec.split(dots === "..." ? "..." : "..");
    const target = await revParse(repo, b || "HEAD");
    if (!a || !target) throw new Error(`cannot resolve range: ${spec}`);
    let base: string | null;
    if (dots === "...") {
      const mb = await git(repo, ["merge-base", a, b || "HEAD"], { allowFail: true });
      base = mb.code === 0 ? mb.stdout.trim() : null;
    } else {
      base = await revParse(repo, a);
    }
    if (!base) throw new Error(`cannot resolve range: ${spec}`);
    return { spec, diffArgs: [base, target], baseRef: base, targetRef: target };
  }

  // Single commit-ish (including "HEAD"): the diff introduced by that commit.
  const target = await revParse(repo, spec);
  if (!target) throw new Error(`cannot resolve revision: ${spec}`);
  const parent = await revParse(repo, `${spec}^`);
  const base = parent ?? EMPTY_TREE;
  return { spec, diffArgs: [base, target], baseRef: base, targetRef: target };
}

// ---------------------------------------------------------------------------
// Manifest

interface RawEntry {
  status: FileStatus;
  path: string;
  oldPath?: string;
  oldMode?: string;
  newMode?: string;
}

const STATUS_MAP: Record<string, FileStatus> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  C: "copied",
  T: "type-changed",
  U: "unmerged",
};

/** Parse `git diff --raw -z` output. */
function parseRaw(out: string): RawEntry[] {
  const tokens = out.split("\0");
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i];
    if (!meta || !meta.startsWith(":")) {
      i++;
      continue;
    }
    // :<oldmode> <newmode> <oldsha> <newsha> <status[score]>
    const fields = meta.slice(1).split(" ");
    const statusField = fields[4] ?? "M";
    const letter = statusField[0] ?? "M";
    const status = STATUS_MAP[letter] ?? "modified";
    const oldMode = fields[0];
    const newMode = fields[1];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      entries.push({ status, path: newPath, oldPath, oldMode, newMode });
      i += 3;
    } else {
      entries.push({ status, path: tokens[i + 1] ?? "", oldMode, newMode });
      i += 2;
    }
  }
  return entries;
}

interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Parse `git diff --numstat -z` output. */
function parseNumstat(out: string): NumstatEntry[] {
  const tokens = out.split("\0");
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const rec = tokens[i];
    if (!rec) {
      i++;
      continue;
    }
    const [addStr, delStr, inlinePath] = rec.split("\t");
    const binary = addStr === "-";
    const additions = binary ? 0 : Number(addStr);
    const deletions = binary ? 0 : Number(delStr);
    if (inlinePath !== undefined && inlinePath !== "") {
      entries.push({ path: inlinePath, additions, deletions, binary });
      i += 1;
    } else {
      // Rename: the record ends with just "added\tdeleted\t"; two path tokens follow.
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      entries.push({ path: newPath, oldPath, additions, deletions, binary });
      i += 3;
    }
  }
  return entries;
}

export async function computeManifest(
  repo: string,
  range: ResolvedRange,
  revision: number,
): Promise<DiffManifest> {
  const [raw, numstat] = await Promise.all([
    git(repo, ["diff", ...DIFF_FLAGS, "--raw", "-z", ...range.diffArgs, "--"]),
    git(repo, ["diff", ...DIFF_FLAGS, "--numstat", "-z", ...range.diffArgs, "--"]),
  ]);

  const rawEntries = parseRaw(raw.stdout);
  const numstats = new Map(parseNumstat(numstat.stdout).map((e) => [e.path, e]));

  const files: ManifestFile[] = rawEntries.map((e) => {
    const ns = numstats.get(e.path);
    const additions = ns?.additions ?? 0;
    const deletions = ns?.deletions ?? 0;
    const file: ManifestFile = {
      path: e.path,
      status: e.status,
      additions,
      deletions,
      binary: ns?.binary ?? false,
      large: additions + deletions > LARGE_FILE_LINES,
    };
    if (e.oldPath) file.old_path = e.oldPath;
    if (e.oldMode && e.newMode && e.oldMode !== e.newMode && e.oldMode !== "000000" && e.newMode !== "000000") {
      file.old_mode = e.oldMode;
      file.new_mode = e.newMode;
    }
    return file;
  });

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    range: range.spec,
    revision,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

// ---------------------------------------------------------------------------
// Per-file hunks

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parse a unified diff (for a single file) into structured hunks. */
export function parseUnifiedDiff(text: string): { binary: boolean; hunks: Hunk[] } {
  const lines = text.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let binary = false;

  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        old_start: Number(m[1]),
        old_lines: m[2] !== undefined ? Number(m[2]) : 1,
        new_start: Number(m[3]),
        new_lines: m[4] !== undefined ? Number(m[4]) : 1,
        header: m[5] ?? "",
        lines: [],
      };
      oldLine = current.old_start;
      newLine = current.new_start;
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        binary = true;
      }
      continue; // file header lines (diff --git, index, ---, +++, mode, rename)
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" applies to the previous line.
      const prev = current.lines[current.lines.length - 1];
      if (prev) prev.no_newline = true;
      continue;
    }
    const marker = line[0];
    const text_ = line.slice(1);
    let hl: HunkLine | null = null;
    if (marker === "+") {
      hl = { kind: "add", old_line: null, new_line: newLine++, text: text_ };
    } else if (marker === "-") {
      hl = { kind: "del", old_line: oldLine++, new_line: null, text: text_ };
    } else if (marker === " ") {
      hl = { kind: "context", old_line: oldLine++, new_line: newLine++, text: text_ };
    } else if (line === "") {
      // git emits a bare empty line for an empty context line in some cases;
      // also the trailing newline of the diff produces one final empty token.
      continue;
    }
    if (hl) current.lines.push(hl);
  }

  return { binary, hunks };
}

export interface FileDiffOptions {
  /** Serve hunks even if the file exceeds the large threshold. */
  force?: boolean;
  context?: number;
}

export async function computeFileDiff(
  repo: string,
  range: ResolvedRange,
  file: ManifestFile,
  opts: FileDiffOptions = {},
): Promise<FileDiff> {
  const base: FileDiff = {
    path: file.path,
    binary: file.binary,
    large: file.large,
    hunks: [],
  };
  if (file.old_path) base.old_path = file.old_path;
  if (file.binary) return base;
  if (file.large && !opts.force) return base;

  const pathspecs = file.old_path ? [file.old_path, file.path] : [file.path];
  const context = opts.context ?? 3;
  const r = await git(repo, [
    "diff",
    ...DIFF_FLAGS,
    `--unified=${context}`,
    ...range.diffArgs,
    "--",
    ...pathspecs,
  ]);
  const parsed = parseUnifiedDiff(r.stdout);
  base.binary = base.binary || parsed.binary;
  base.hunks = parsed.hunks;
  if (file.large && opts.force) base.large = false;
  return base;
}

// ---------------------------------------------------------------------------
// Raw diff text (persisted per revision so history stays viewable)

/** Full unified diff for the range, exactly as git prints it. */
export async function computeRawDiff(repo: string, range: ResolvedRange): Promise<string> {
  const r = await git(repo, ["diff", ...DIFF_FLAGS, "--unified=3", ...range.diffArgs, "--"]);
  return r.stdout;
}

/**
 * Split a multi-file unified diff into per-file sections, keyed by the file's
 * path as the manifest reports it (new path; old path for deletions).
 * Used to (a) serve historical per-file hunks and (b) detect which files'
 * diff content actually changed between revisions (viewed-flag reset).
 */
export function splitFileSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  if (!raw) return sections;
  const lines = raw.split("\n");
  let start = -1;
  const flush = (end: number) => {
    if (start === -1) return;
    const section = lines.slice(start, end).join("\n");
    const key = sectionPath(lines, start, end);
    if (key) sections.set(key, section);
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("diff --git ")) {
      flush(i);
      start = i;
    }
  }
  flush(lines.length);
  return sections;
}

function sectionPath(lines: string[], start: number, end: number): string | null {
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (line.startsWith("+++ b/")) return line.slice("+++ b/".length);
    if (line.startsWith("rename to ")) return line.slice("rename to ".length);
    if (line.startsWith("+++ /dev/null")) {
      // Deletion: fall back to the old path.
      for (let j = start; j < end; j++) {
        const l = lines[j]!;
        if (l.startsWith("--- a/")) return l.slice("--- a/".length);
      }
    }
    if (HUNK_RE.test(line)) break; // past the header; nothing more to find
  }
  // No ---/+++ header (binary or mode-only change): parse `diff --git a/X b/X`.
  const header = lines[start]!.slice("diff --git ".length);
  const m = /^a\/(.*) b\/\1$/.exec(header); // identical paths (the common case)
  if (m) return m[1] ?? null;
  const half = /^a\/.* b\/(.*)$/.exec(header);
  return half?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// File content (for comment anchoring)

/**
 * Full content of one side of the diff for `filePath`, split into lines.
 * Returns null when the file doesn't exist on that side (or is binary-ish).
 */
export async function sideContent(
  repo: string,
  range: ResolvedRange,
  side: Side,
  filePath: string,
): Promise<string[] | null> {
  if (side === "new") {
    if (range.targetRef === null) {
      const f = Bun.file(path.join(repo, filePath));
      if (!(await f.exists())) return null;
      return splitLines(await f.text());
    }
    if (range.targetRef === ":index") {
      const r = await git(repo, ["show", `:${filePath}`], { allowFail: true });
      return r.code === 0 ? splitLines(r.stdout) : null;
    }
    const r = await git(repo, ["show", `${range.targetRef}:${filePath}`], { allowFail: true });
    return r.code === 0 ? splitLines(r.stdout) : null;
  }
  if (range.baseRef === EMPTY_TREE) return null;
  const r = await git(repo, ["show", `${range.baseRef}:${filePath}`], { allowFail: true });
  return r.code === 0 ? splitLines(r.stdout) : null;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // A trailing newline yields one empty trailing element; drop it so the
  // array is exactly the file's lines.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
