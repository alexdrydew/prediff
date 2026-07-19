import type { ReactElement } from "react";
/**
 * In-diff content search (QA gap §1.3). Cmd/Ctrl+F opens it; matches are
 * computed server-side over the diff's hunks, so collapsed and large-withheld
 * files are searchable. Enter/arrows navigate; jumping expands the file,
 * scrolls to the line and flashes it.
 */

import { useEffect, useRef } from "react";
import type { SearchMatch } from "../types";
import {
  closeSearch,
  setSearchActive,
  setSearchQuery,
  useStore,
} from "../state/store";
import { jumpToSearchMatch } from "../state/controller";

function matchLoc(m: SearchMatch): string {
  return `${m.file}:${m.line}${m.side === "old" ? " (old)" : ""}`;
}

export function SearchOverlay(): ReactElement | null {
  const search = useStore((s) => s.search);
  const listRef = useRef<HTMLDivElement>(null);
  /** Last match Enter jumped to, so a repeated Enter advances. */
  const lastJumped = useRef<{ list: SearchMatch[] | null; idx: number }>({ list: null, idx: -1 });

  // Keep the active row visible as arrows move the selection.
  useEffect(() => {
    if (!search.open) return;
    listRef.current
      ?.querySelector(".search-hit-row.on")
      ?.scrollIntoView({ block: "nearest" });
  }, [search.activeIdx, search.open]);

  if (!search.open) return null;
  const matches = search.matches ?? [];

  const jump = (idx: number): void => {
    const m = matches[idx];
    if (!m) return;
    setSearchActive(idx);
    void jumpToSearchMatch(m);
  };

  const step = (dir: 1 | -1, andJump: boolean): void => {
    if (matches.length === 0) return;
    const next = (search.activeIdx + dir + matches.length) % matches.length;
    if (andJump) jump(next);
    else setSearchActive(next);
  };

  return (
    <div className="search-ov" role="dialog" aria-label="Search diff content">
      <div className="search-ov-bar">
        <span className="search-ic">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
        </span>
        <input
          autoFocus
          placeholder="Search diff content…"
          value={search.query}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const n = matches.length;
              if (n === 0) return;
              // First Enter jumps to the selected match; repeats advance.
              const again =
                lastJumped.current.list === search.matches &&
                lastJumped.current.idx === search.activeIdx;
              const target = e.shiftKey
                ? (search.activeIdx - 1 + n) % n
                : again
                  ? (search.activeIdx + 1) % n
                  : search.activeIdx;
              lastJumped.current = { list: search.matches, idx: target };
              jump(target);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              step(1, false);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              step(-1, false);
            } else if (e.key === "Escape") {
              closeSearch();
            }
          }}
        />
        <span className="search-ov-count">
          {search.status === "loading"
            ? "searching…"
            : search.status === "error"
              ? "error"
              : search.matches === null
                ? ""
                : matches.length === 0
                  ? "no matches"
                  : `${Math.min(search.activeIdx + 1, matches.length)} / ${matches.length}${search.truncated ? "+" : ""}`}
        </span>
        <button className="search-ov-close" title="Close (Esc)" onClick={closeSearch}>
          ✕
        </button>
      </div>
      {search.status === "error" && (
        <div className="search-ov-note">search failed: {search.error}</div>
      )}
      {matches.length > 0 && (
        <div className="search-ov-list" ref={listRef}>
          {matches.map((m, i) => (
            <button
              key={`${m.file}:${m.side}:${m.line}:${i}`}
              className={`search-hit-row${i === search.activeIdx ? " on" : ""}`}
              onClick={() => jump(i)}
            >
              <span className="loc">{matchLoc(m)}</span>
              <span className="prev">{m.preview}</span>
            </button>
          ))}
        </div>
      )}
      {search.truncated && (
        <div className="search-ov-note">
          Showing the first {matches.length} matches — refine the query for more precision.
        </div>
      )}
      <div className="search-ov-hint">
        <kbd>Enter</kbd> jump to match · <kbd>↑</kbd>
        <kbd>↓</kbd> select · <kbd>Esc</kbd> close — searches all files, including collapsed ones
      </div>
    </div>
  );
}
