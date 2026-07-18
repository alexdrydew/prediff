/**
 * "Outside stated scope" heuristic (spec §9.4). Deliberately cheap and
 * clearly informational: a file is flagged when its path shares no tokens
 * with the scope keywords. Never blocks anything.
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "fix", "fixes", "bug", "add", "adds", "update", "updates",
  "remove", "removes", "refactor", "implement", "implements", "make", "makes",
  "with", "from", "into", "that", "this", "when", "where", "not", "all", "new",
  "use", "uses", "using", "support", "issue", "feature", "change", "changes",
]);

const MIN_TOKEN = 3;

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= MIN_TOKEN && !STOPWORDS.has(w),
  );
}

export function scopeKeywords(scope: string | null): string[] {
  if (scope === null || scope.trim() === "") return [];
  return [...new Set(words(scope))];
}

function pathTokens(path: string): string[] {
  return words(path.replace(/\.[^./]+$/, ""));
}

/** True when the path shares no token (substring either way, len ≥ 3) with
 * any scope keyword. Empty keywords → nothing is ever out of scope. */
export function outsideScope(path: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const tokens = pathTokens(path);
  for (const token of tokens) {
    for (const kw of keywords) {
      if (token.includes(kw) || kw.includes(token)) return false;
    }
  }
  return true;
}
