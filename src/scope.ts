/**
 * "Outside stated scope" flagging (spec §9.4). Computed server-side and
 * exposed per file as `scope_flag` on the manifest (QA gap §1.2 rework —
 * the earlier client-side heuristic matched scope words against file PATHS
 * only, which flagged the very file that wires a feature in whenever its
 * name didn't echo the scope words). Two modes, both strictly informational
 * (never blocks anything):
 *
 * 1. Explicit: `prediff open --scope-files "src/lib/**,src/routes/users.ts"`
 *    stores glob patterns on the session; a file matching no pattern is
 *    flagged. Replaces the heuristic entirely.
 *
 * 2. Heuristic, content-aware:
 *    - a file is STRONGLY matched when any scope keyword overlaps a token of
 *      its path segments OR a token of its diff content (changed-line text;
 *      identifiers are split on camelCase, so scope "URL validation" matches
 *      a diff that introduces `validateUrl(...)` calls);
 *    - a file is also in scope when it lives in the same directory as any
 *      strongly-matched file (changes cluster — a caching task touching
 *      src/cache.py keeps src/db.py in scope);
 *    - if more than half of the changed files would still be flagged, the
 *      signal is meaningless — ALL flags are suppressed.
 *
 * Every flag carries a human-readable reason (surfaced as a tooltip).
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "fix", "fixes", "bug", "add", "adds", "update", "updates",
  "remove", "removes", "refactor", "implement", "implements", "make", "makes",
  "with", "from", "into", "that", "this", "when", "where", "not", "all", "new",
  "use", "uses", "using", "support", "issue", "feature", "change", "changes",
]);

const MIN_TOKEN = 3;

/** Flags are suppressed when more than this fraction of files would flag. */
export const SUPPRESS_FRACTION = 0.5;

/** Tokenize: split camelCase, then take alphanumeric runs ≥ MIN_TOKEN. */
function words(text: string): string[] {
  const decamel = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return (decamel.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= MIN_TOKEN && !STOPWORDS.has(w),
  );
}

export function scopeKeywords(scope: string | null): string[] {
  if (scope === null || scope.trim() === "") return [];
  return [...new Set(words(scope))];
}

/** Tokens of every path segment (directories AND basename), extension dropped. */
function pathTokens(path: string): string[] {
  return words(path.replace(/\.[^./]+$/, ""));
}

function tokenMatches(token: string, kw: string): boolean {
  return token.includes(kw) || kw.includes(token);
}

/** True when any path-segment token overlaps any scope keyword. */
function pathMatched(path: string, keywords: readonly string[]): boolean {
  return pathTokens(path).some((token) => keywords.some((kw) => tokenMatches(token, kw)));
}

/** True when any token of the file's changed-line text overlaps a keyword. */
function contentMatched(diffText: string, keywords: readonly string[]): boolean {
  if (diffText === "") return false;
  const tokens = new Set(words(diffText));
  for (const token of tokens) {
    if (keywords.some((kw) => tokenMatches(token, kw))) return true;
  }
  return false;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Extract the changed-line text (added + deleted lines, markers stripped)
 * from one file's raw unified-diff section. Context lines are excluded so
 * untouched surrounding code can't put a file in scope.
 */
export function changedLinesText(section: string | undefined): string {
  if (!section) return "";
  return section
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    )
    .map((line) => line.slice(1))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Glob matching for --scope-files patterns.
// Supported: `**` (any path, across separators), `*` (within a segment),
// `?` (single char within a segment). Everything else is literal.

const globCache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

// ---------------------------------------------------------------------------

export interface ScopeFileInput {
  path: string;
  /** Changed-line text from this file's diff (see changedLinesText). */
  diff_text?: string;
}

/**
 * Compute out-of-scope flags for the whole change set. Returns a map of
 * path → reason for flagged files only (empty map = nothing flagged).
 */
export function computeScopeFlags(
  files: readonly ScopeFileInput[],
  scope: string | null,
  scopeFiles: readonly string[] | null,
): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();

  // Explicit file list: replaces the heuristic entirely.
  if (scopeFiles !== null && scopeFiles.length > 0) {
    for (const { path } of files) {
      if (!matchesAnyGlob(path, scopeFiles)) {
        flags.set(
          path,
          `Outside the agent's declared scope files (matches none of: ${scopeFiles.join(", ")})`,
        );
      }
    }
    return flags;
  }

  const keywords = scopeKeywords(scope);
  if (keywords.length === 0) return flags;

  const strong = new Set(
    files
      .filter(
        (f) => pathMatched(f.path, keywords) || contentMatched(f.diff_text ?? "", keywords),
      )
      .map((f) => f.path),
  );
  const strongDirs = new Set([...strong].map(dirname));
  for (const { path } of files) {
    if (strong.has(path)) continue;
    if (strongDirs.has(dirname(path))) continue; // shares a directory with a match
    flags.set(
      path,
      `Neither the path nor the diff content shares keywords with the stated scope ` +
        `("${scope}"), and no directory with a scope-matched file — informational only`,
    );
  }

  // A signal that fires on most of the diff carries no information: suppress.
  if (flags.size > files.length * SUPPRESS_FRACTION) return new Map();
  return flags;
}
