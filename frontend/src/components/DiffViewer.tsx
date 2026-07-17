import type { ReactElement } from "react";
/**
 * The single virtualized list every review renders through. One virtualizer
 * windows over the flat row model (file headers, hunks, lines, threads,
 * composers), keeping DOM size bounded regardless of diff size.
 */

import { memo, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { selectRows } from "../state/selectors";
import { cancelSelection, commitSelection, useStore } from "../state/store";
import { estimateRowHeight, isDynamicRow, type Row } from "../lib/rows";
import { languageForPath } from "../lib/language";
import { FileHeaderRow } from "./rows/FileHeaderRow";
import { HunkHeaderRow } from "./rows/HunkHeaderRow";
import { UnifiedLineRow } from "./rows/UnifiedLineRow";
import { SplitLineRow } from "./rows/SplitLineRow";
import { MetaRow } from "./rows/MetaRow";
import { ThreadRow } from "./rows/ThreadRow";
import { ComposerRow } from "./rows/ComposerRow";

/** Fixed per-row chrome left of the code text (two gutters + sign column). */
const ROW_CHROME_PX = 120;

function selectCanvasChars(state: Parameters<typeof selectRows>[0]): number {
  let max = 80;
  for (const path of state.expanded) {
    const chars = state.fileDiffs[path]?.maxLineChars ?? 0;
    if (chars > max) max = chars;
  }
  return max;
}

export function DiffViewer(): ReactElement {
  const rows = useStore(selectRows);
  const viewMode = useStore((s) => s.viewMode);
  const canvasChars = useStore(selectCanvasChars);
  const hasSelection = useStore((s) => s.selection !== null);
  const parentRef = useRef<HTMLDivElement>(null);

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
  );
}

const RowView = memo(function RowView({ row }: { row: Row }): ReactElement {
  switch (row.kind) {
    case "file":
      return (
        <FileHeaderRow
          file={row.file}
          expanded={row.expanded}
          commentCount={row.commentCount}
          openCommentCount={row.openCommentCount}
        />
      );
    case "hunk":
      return <HunkHeaderRow hunk={row.hunk} />;
    case "line":
      return <UnifiedLineRow path={row.path} line={row.line} lang={languageForPath(row.path)} />;
    case "pair":
      return <SplitLineRow path={row.path} pair={row.pair} lang={languageForPath(row.path)} />;
    case "meta":
      return <MetaRow path={row.path} variant={row.variant} message={row.message} />;
    case "thread":
      return <ThreadRow comment={row.comment} detached={row.detached} />;
    case "composer":
      return <ComposerRow target={row.target} />;
  }
});
