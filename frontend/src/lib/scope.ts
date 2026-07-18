/**
 * "Outside stated scope" flagging (spec §9.4). Two modes, both strictly
 * informational (never blocks anything):
 *
 * 1. Explicit: `prediff open --scope-files "src/lib/**,src/routes/users.ts"`
 *    stores glob patterns on the session; a file matching no pattern is
 *    flagged. Replaces the heuristic entirely.
 *
 * 2. Heuristic (QA F2 rework — the old any-token-overlap version flagged
 *    core files on valid tasks):
 *    - a file is STRONGLY matched when any of its path segments shares a
 *      token with the scope keywords;
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

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
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
function stronglyMatched(path: string, keywords: readonly string[]): boolean {
  return pathTokens(path).some((token) => keywords.some((kw) => tokenMatches(token, kw)));
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
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

/**
 * Compute out-of-scope flags for the whole change set. Returns a map of
 * path → reason for flagged files only (empty map = nothing flagged).
 */
export function computeScopeFlags(
  paths: readonly string[],
  scope: string | null,
  scopeFiles: readonly string[] | null,
): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();

  // Explicit file list: replaces the heuristic entirely.
  if (scopeFiles !== null && scopeFiles.length > 0) {
    for (const path of paths) {
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

  const strong = paths.filter((p) => stronglyMatched(p, keywords));
  const strongDirs = new Set(strong.map(dirname));
  for (const path of paths) {
    if (stronglyMatched(path, keywords)) continue;
    if (strongDirs.has(dirname(path))) continue; // shares a directory with a match
    flags.set(
      path,
      `Path shares no keywords with the stated scope ("${scope}") and no directory ` +
        "with a scope-matched file — informational only",
    );
  }

  // A signal that fires on most of the diff carries no information: suppress.
  if (flags.size > paths.length * SUPPRESS_FRACTION) return new Map();
  return flags;
}
