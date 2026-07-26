import {
  processFile,
  type ChangeTypes,
  type FileDiffMetadata,
  type SupportedLanguages,
} from "@pierre/diffs";
import type { FileDiff, ManifestFile, Side } from "../types";
import type { FileDiffState } from "../state/store";

const CHANGE_TYPE: Record<ManifestFile["status"], ChangeTypes> = {
  added: "new",
  deleted: "deleted",
  modified: "change",
  renamed: "rename-changed",
  copied: "change",
  "type-changed": "change",
  unmerged: "change",
};

const parsedCache = new WeakMap<
  FileDiff,
  { oldContent: string | null | undefined; newContent: string | null | undefined; value: FileDiffMetadata }
>();

/** Convert Prediff's wire format back to a standard patch for Diffs to parse. */
export function filePatch(file: ManifestFile, diff: FileDiff): string {
  const oldName = file.old_path ?? file.path;
  const lines = [`diff --git a/${oldName} b/${file.path}`];
  if (file.status === "added") lines.push("new file mode 100644");
  if (file.status === "deleted") lines.push("deleted file mode 100644");
  if (file.status === "renamed") {
    lines.push(diff.hunks.length === 0 ? "similarity index 100%" : "similarity index 99%");
    lines.push(`rename from ${oldName}`, `rename to ${file.path}`);
  }
  lines.push(
    file.status === "added" ? "--- /dev/null" : `--- a/${oldName}`,
    file.status === "deleted" ? "+++ /dev/null" : `+++ b/${file.path}`,
  );
  for (const hunk of diff.hunks) {
    const oldRange = formatRange(hunk.old_start, hunk.old_lines);
    const newRange = formatRange(hunk.new_start, hunk.new_lines);
    lines.push(`@@ -${oldRange} +${newRange} @@${hunk.header ? ` ${hunk.header}` : ""}`);
    for (const line of hunk.lines) {
      lines.push(`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
      if (line.no_newline) lines.push("\\ No newline at end of file");
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Diffs owns parsing, inline highlighting, expansion, and render metadata. */
export function pierreFileDiff(
  file: ManifestFile,
  state: FileDiffState | undefined,
  cacheKey: string,
): FileDiffMetadata {
  const contentKey = [
    cacheKey,
    state?.status ?? "idle",
    state?.diff?.hunks.length ?? -1,
    typeof state?.oldContent === "string",
    typeof state?.newContent === "string",
  ].join(":");
  if (!state?.diff || state.diff.binary) return emptyDiff(file, contentKey);
  const cached = parsedCache.get(state.diff);
  if (
    cached &&
    cached.oldContent === state.oldContent &&
    cached.newContent === state.newContent
  ) {
    return cached.value.cacheKey === contentKey
      ? cached.value
      : { ...cached.value, cacheKey: contentKey };
  }
  const oldName = file.old_path ?? file.path;
  const oldContent = state.oldContent;
  const newContent = state.newContent;
  const complete =
    typeof oldContent === "string" && typeof newContent === "string";
  const parsed = processFile(filePatch(file, state.diff), {
    isGitDiff: true,
    ...(complete
      ? {
          oldFile: { name: oldName, contents: oldContent },
          newFile: { name: file.path, contents: newContent },
        }
      : {}),
    throwOnError: true,
  });
  const value = parsed
    ? {
        ...parsed,
        cacheKey: contentKey,
        lang: languageForPath(file.path),
      }
    : emptyDiff(file, contentKey);
  parsedCache.set(state.diff, {
    oldContent: state.oldContent,
    newContent: state.newContent,
    value,
  });
  return value;
}

export function lineInDiff(diff: FileDiff | undefined, side: Side, line: number): boolean {
  return (
    diff?.hunks.some((hunk) =>
      hunk.lines.some((entry) => (side === "old" ? entry.old_line : entry.new_line) === line),
    ) ?? false
  );
}

function emptyDiff(file: ManifestFile, cacheKey: string): FileDiffMetadata {
  return {
    name: file.path,
    ...(file.old_path ? { prevName: file.old_path } : {}),
    type: CHANGE_TYPE[file.status],
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    cacheKey,
    lang: languageForPath(file.path),
  };
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

const EXTENSION_LANG: Readonly<Record<string, SupportedLanguages>> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  sh: "zsh",
  bash: "zsh",
  zsh: "zsh",
  json: "json",
  jsonc: "jsonc",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  vue: "vue",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  lua: "lua",
  pl: "perl",
  r: "r",
  scala: "scala",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
};

function languageForPath(path: string): SupportedLanguages {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const extension = base.slice(base.lastIndexOf(".") + 1);
  return EXTENSION_LANG[extension] ?? "text";
}
