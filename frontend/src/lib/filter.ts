/**
 * File-tree filter box: fuzzy filename match plus typed filters
 * (`is:unviewed`, `is:commented`, `is:agent-touched`), combinable (spec §7.5).
 */

export type TypedFilter = "unviewed" | "commented" | "agent-touched";

export interface ParsedFilter {
  /** Free-text part, for fuzzy filename matching. */
  text: string;
  filters: TypedFilter[];
  /** `is:` tokens that aren't a known filter (ignored, but reported). */
  unknown: string[];
}

const KNOWN: ReadonlySet<string> = new Set(["unviewed", "commented", "agent-touched"]);

export function parseFilter(query: string): ParsedFilter {
  const filters: TypedFilter[] = [];
  const unknown: string[] = [];
  const text: string[] = [];
  for (const token of query.trim().split(/\s+/)) {
    if (token === "") continue;
    const m = /^is:(.*)$/i.exec(token);
    if (m) {
      const name = (m[1] ?? "").toLowerCase();
      if (KNOWN.has(name)) {
        if (!filters.includes(name as TypedFilter)) filters.push(name as TypedFilter);
      } else {
        unknown.push(name);
      }
    } else {
      text.push(token);
    }
  }
  return { text: text.join(" ").toLowerCase(), filters, unknown };
}

/** Case-insensitive subsequence match ("fuzzy"): every query char appears in
 * order in the path. Empty query matches everything. */
export function fuzzyMatch(path: string, query: string): boolean {
  if (query === "") return true;
  const hay = path.toLowerCase();
  let i = 0;
  for (const ch of query.toLowerCase()) {
    if (ch === " ") continue;
    i = hay.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

export interface FileFilterInfo {
  viewed: boolean;
  commentCount: number;
  agentTouched: boolean;
}

export function matchesFilter(path: string, info: FileFilterInfo, parsed: ParsedFilter): boolean {
  if (!fuzzyMatch(path, parsed.text)) return false;
  for (const f of parsed.filters) {
    if (f === "unviewed" && info.viewed) return false;
    if (f === "commented" && info.commentCount === 0) return false;
    if (f === "agent-touched" && !info.agentTouched) return false;
  }
  return true;
}
