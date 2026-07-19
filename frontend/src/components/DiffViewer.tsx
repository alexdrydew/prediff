import type { ReactElement } from "react";
/**
 * The single virtualized list every review renders through. One virtualizer
 * windows over the flat row model (file headers, hunks, lines, threads,
 * composers, expand controls), keeping DOM size bounded regardless of diff
 * size. Also owns viewport tracking for the sticky context header (§6.2) and
 * the tree ↔ panel scroll sync (§7.2).
 */

import { memo, useCallback, useEffect, useRef } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { selectRows } from "../state/selectors";
import { setActiveContext, store, useStore } from "../state/store";
import { noteRowInteraction, noteScroll, registerDiffController } from "../state/controller";
import { estimateRowHeight, isDynamicRow, type Row } from "../lib/rows";
import { languageForPath } from "../lib/language";
import { FileHeaderRow } from "./rows/FileHeaderRow";
import { HunkHeaderRow } from "./rows/HunkHeaderRow";
import { UnifiedLineRow } from "./rows/UnifiedLineRow";
import { SplitLineRow } from "./rows/SplitLineRow";
import { ExpandRow } from "./rows/ExpandRow";
import { MetaRow } from "./rows/MetaRow";
import { ThreadRow } from "./rows/ThreadRow";
import { ComposerRow } from "./rows/ComposerRow";
import { ReviewComposerRow } from "./rows/ReviewComposerRow";
import { Minimap } from "./Minimap";

/** Fixed per-row chrome left of the code text (two gutters + sign column). */
const ROW_CHROME_PX = 120;

function selectCanvasChars(state: Parameters<typeof selectRows>[0]): number {
  let max = 80;
  for (const path in state.fileDiffs) {
    const chars = state.fileDiffs[path]?.maxLineChars ?? 0;
    if (chars > max) max = chars;
  }
  return max;
}

/** Which file/hunk a row belongs to, for the sticky header. */
function rowContext(row: Row): { path: string | null; hunkIdx: number | null } {
  switch (row.kind) {
    case "file":
      return { path: row.file.path, hunkIdx: null };
    case "hunk":
    case "line":
    case "pair":
    case "expand":
      return { path: row.path, hunkIdx: row.hunkIdx };
    case "thread":
    case "composer":
    case "meta":
      return { path: row.path, hunkIdx: null };
    case "review-label":
    case "review-composer":
      return { path: null, hunkIdx: null };
  }
}

export function DiffViewer(): ReactElement {
  const rows = useStore(selectRows);
  const viewMode = useStore((s) => s.viewMode);
  const wrapLines = useStore((s) => s.wrapLines);
  const canvasChars = useStore(selectCanvasChars);
  const parentRef = useRef<HTMLDivElement>(null);
  const topIndexRef = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row ? estimateRowHeight(row) : 22;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
  });
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element>>(virtualizer);
  virtualizerRef.current = virtualizer;

  /** Row index at the top of the viewport, computed synchronously from the
   * scroll offset (never from a cached value — scroll events and rAF can lag
   * behind programmatic scrolling). */
  const computeTopIndex = useCallback((): number => {
    const el = parentRef.current;
    if (!el) return 0;
    const top = el.scrollTop + 2;
    const items = virtualizerRef.current.getVirtualItems();
    const current = items.find((it) => it.end > top) ?? items[items.length - 1];
    return current ? current.index : 0;
  }, []);

  // Viewport tracking: which row is at the top → sticky header + tree sync.
  const updateContext = useCallback((): void => {
    const el = parentRef.current;
    if (!el) return;
    const top = el.scrollTop + 2;
    const items = virtualizerRef.current.getVirtualItems();
    let current = items.find((it) => it.end > top) ?? items[items.length - 1];
    if (!current) {
      setActiveContext(null, null);
      return;
    }
    topIndexRef.current = current.index;
    const row = rowsRef.current[current.index];
    if (!row) return;
    const ctx = rowContext(row);
    if (ctx.path === null) {
      setActiveContext(null, null);
      return;
    }
    let hunk: { idx: number; count: number } | null = null;
    if (ctx.hunkIdx !== null) {
      const count = store.getState().fileDiffs[ctx.path]?.diff?.hunks.length ?? 0;
      if (count > 0) hunk = { idx: ctx.hunkIdx, count };
    }
    setActiveContext(ctx.path, hunk);
  }, []);

  useEffect(() => {
    registerDiffController({
      scrollToIndex: (index, align = "start") => {
        virtualizerRef.current.scrollToIndex(index, { align });
        // With soft wrap on, row heights are estimates until rendered rows
        // measure, so a deep jump can land short. Re-issue the scroll for a
        // few frames until the target offset stabilizes (each extra pass is
        // a no-op once measurements have settled — wrap off settles on the
        // first frame).
        let prevOffset: number | null = null;
        let passes = 8;
        const settle = (): void => {
          const v = virtualizerRef.current;
          const offset = v.getOffsetForIndex(index, align)?.[0];
          if (offset === undefined) return;
          if (prevOffset !== null && Math.abs(offset - prevOffset) < 1) return;
          prevOffset = offset;
          v.scrollToIndex(index, { align });
          if (--passes > 0) requestAnimationFrame(settle);
        };
        requestAnimationFrame(settle);
        // Scroll events / rAF can be throttled (background tabs); make sure
        // the sticky header and top-index tracking still catch up.
        setTimeout(updateContext, 50);
      },
      getTopIndex: computeTopIndex,
    });
    return () => registerDiffController(null);
  }, [computeTopIndex, updateContext]);

  // Toggling wrap changes every code row's height: drop cached measurements
  // so stale wrapped heights never position unwrapped rows (and vice versa).
  const wrapWasOn = useRef(wrapLines);
  useEffect(() => {
    if (wrapWasOn.current === wrapLines) return;
    wrapWasOn.current = wrapLines;
    virtualizerRef.current.measure();
  }, [wrapLines]);

  // With wrap on, wrapped heights depend on the pane width. Rendered rows
  // re-measure themselves (measureElement observes them), but cached offscreen
  // measurements would go stale — flush the cache when the width changes
  // (window resize, tree-width drag).
  useEffect(() => {
    if (!wrapLines) return;
    const el = parentRef.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width !== lastWidth) {
        lastWidth = width;
        virtualizerRef.current.measure();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [wrapLines]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = (): void => {
      // User scrolls release the keyboard-focus anchor (programmatic scrolls
      // are filtered out inside noteScroll) — nav follows the viewport again.
      noteScroll();
      if (raf === 0) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          updateContext();
        });
      }
    };
    // Any mouse interaction with a diff row or comment card re-syncs the
    // keyboard-focus anchor to that row (QA F4): n/p/c act from where the
    // user actually is, not from a stale viewport/nav position.
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const vrow = target?.closest<HTMLElement>(".vrow") ?? null;
      const index = vrow ? Number(vrow.dataset["index"]) : NaN;
      const row = Number.isInteger(index) ? rowsRef.current[index] : undefined;
      if (row) noteRowInteraction(row.key);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("mousedown", onMouseDown);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [updateContext]);

  // Rows changed (loads, expands, revision switch): re-derive the context.
  useEffect(() => {
    updateContext();
  }, [rows, updateContext]);

  // Selection commit lives in beginSelection (store); Escape-cancel lives in
  // the global keyboard model. Nothing to wire up here.

  // With wrap off, the unified-mode canvas grows with the longest loaded line
  // so long code is reachable by horizontal scroll (split mode ellipsizes
  // within panes). With wrap on, code wraps to the pane width instead.
  const canvasMinWidth =
    viewMode === "unified" && !wrapLines
      ? `calc(${canvasChars}ch + ${ROW_CHROME_PX}px)`
      : "100%";

  return (
    <div className="diff-wrap">
      <div className="diff-scroll" ref={parentRef}>
        <div
          className={`diff-canvas${wrapLines ? " wrap" : ""}`}
          style={{ height: virtualizer.getTotalSize(), minWidth: canvasMinWidth }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const dynamic = isDynamicRow(row, wrapLines);
            return (
              <div
                key={item.key}
                className="vrow"
                data-index={item.index}
                // Only content-sized rows (threads, composers) are measured;
                // line rows keep their fixed estimate to avoid layout reads.
                ref={dynamic ? virtualizer.measureElement : undefined}
                style={{
                  transform: `translateY(${item.start}px)`,
                  ...(dynamic ? {} : { height: item.size }),
                }}
              >
                <RowView row={row} />
              </div>
            );
          })}
        </div>
      </div>
      <Minimap scrollRef={parentRef} virtualizerRef={virtualizerRef} />
    </div>
  );
}

const RowView = memo(function RowView({ row }: { row: Row }): ReactElement {
  switch (row.kind) {
    case "file":
      return (
        <FileHeaderRow
          file={row.file}
          expanded={row.expanded}
          viewed={row.viewed}
          commentCount={row.commentCount}
          unresolvedCount={row.unresolvedCount}
        />
      );
    case "hunk":
      return <HunkHeaderRow hunk={row.hunk} hunkIdx={row.hunkIdx} hunkCount={row.hunkCount} />;
    case "line":
      return (
        <UnifiedLineRow
          path={row.path}
          line={row.line}
          lang={languageForPath(row.path)}
          counterpart={row.counterpart}
        />
      );
    case "pair":
      return <SplitLineRow path={row.path} pair={row.pair} lang={languageForPath(row.path)} />;
    case "expand":
      return <ExpandRow path={row.path} gap={row.gap} />;
    case "meta":
      return (
        <MetaRow path={row.path} variant={row.variant} message={row.message} lines={row.lines} />
      );
    case "thread":
      return <ThreadRow comment={row.comment} detached={row.detached} />;
    case "composer":
      return <ComposerRow target={row.target} />;
    case "review-label":
      return (
        <div className="review-label">
          Review comments
          <span className="review-label-sub">— about the change as a whole</span>
        </div>
      );
    case "review-composer":
      return <ReviewComposerRow />;
  }
});
