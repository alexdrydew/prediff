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
import {
  cancelSelection,
  commitSelection,
  setActiveContext,
  store,
  useStore,
} from "../state/store";
import { registerDiffController } from "../state/controller";
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
  }
}

export function DiffViewer(): ReactElement {
  const rows = useStore(selectRows);
  const viewMode = useStore((s) => s.viewMode);
  const canvasChars = useStore(selectCanvasChars);
  const hasSelection = useStore((s) => s.selection !== null);
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

  useEffect(() => {
    registerDiffController({
      scrollToIndex: (index, align = "start") =>
        virtualizerRef.current.scrollToIndex(index, { align }),
      getTopIndex: () => topIndexRef.current,
    });
    return () => registerDiffController(null);
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
    const el = parentRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = (): void => {
      if (raf === 0) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          updateContext();
        });
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [updateContext]);

  // Rows changed (loads, expands, revision switch): re-derive the context.
  useEffect(() => {
    updateContext();
  }, [rows, updateContext]);

  // Drag-to-select a line range: commit on mouseup anywhere, cancel on Escape.
  useEffect(() => {
    if (!hasSelection) return;
    const onMouseUp = (): void => commitSelection();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") cancelSelection();
    };
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hasSelection]);

  // Unified mode canvas grows with the longest loaded line so long code is
  // reachable by horizontal scroll; split mode ellipsizes within panes.
  const canvasMinWidth =
    viewMode === "unified" ? `calc(${canvasChars}ch + ${ROW_CHROME_PX}px)` : "100%";

  return (
    <div className="diff-wrap">
      <div className="diff-scroll" ref={parentRef}>
        <div
          className="diff-canvas"
          style={{ height: virtualizer.getTotalSize(), minWidth: canvasMinWidth }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const dynamic = isDynamicRow(row);
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
      return <MetaRow path={row.path} variant={row.variant} message={row.message} />;
    case "thread":
      return <ThreadRow comment={row.comment} detached={row.detached} />;
    case "composer":
      return <ComposerRow target={row.target} />;
  }
});
