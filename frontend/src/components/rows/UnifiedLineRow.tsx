import type { ReactElement } from "react";
import { memo } from "react";
import type { HunkLine, Side } from "../../types";
import {
  beginSelection,
  extendSelection,
  reanchorTo,
  store,
  useStore,
  type LineSelection,
} from "../../state/store";
import { changedRanges, wordDiff } from "../../lib/wordDiff";
import { CodeText } from "./CodeText";

function inSelection(
  sel: LineSelection | null,
  path: string,
  side: Side,
  line: number | null,
): boolean {
  if (!sel || line === null || sel.file !== path || sel.side !== side) return false;
  return line >= Math.min(sel.anchor, sel.head) && line <= Math.max(sel.anchor, sel.head);
}

/** Gutter click: begin a comment range drag — or, in re-anchor mode (§6.4),
 * place the orphaned comment on this line. */
export function gutterMouseDown(path: string, side: Side, line: number): void {
  if (store.getState().reanchoring !== null) {
    void reanchorTo(side, line);
    return;
  }
  beginSelection(path, side, line);
}

function Gutter({
  path,
  side,
  line,
}: {
  path: string;
  side: Side;
  line: number | null;
}): ReactElement {
  return (
    <span
      className="gutter"
      title={line !== null ? "Comment on this line (drag for a range)" : undefined}
      onMouseDown={(e) => {
        if (line === null || e.button !== 0) return;
        e.preventDefault();
        gutterMouseDown(path, side, line);
      }}
      onMouseEnter={() => {
        if (line !== null) extendSelection(path, side, line);
      }}
    >
      {line ?? ""}
    </span>
  );
}

export const UnifiedLineRow = memo(function UnifiedLineRow({
  path,
  line,
  lang,
  counterpart,
}: {
  path: string;
  line: HunkLine;
  lang: string | null;
  /** Paired del/add counterpart text, for word-level marks. */
  counterpart?: string | undefined;
}): ReactElement {
  const selected = useStore(
    (s) =>
      inSelection(s.selection, path, "old", line.old_line) ||
      inSelection(s.selection, path, "new", line.new_line),
  );
  // Transient flash after a content-search jump (QA gap §1.3).
  const searchHit = useStore((s) => {
    const h = s.searchHighlight;
    if (h === null || h.file !== path) return false;
    return h.side === "new" ? line.new_line === h.line : line.old_line === h.line;
  });
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";

  let marks: Array<[number, number]> | undefined;
  if (counterpart !== undefined && line.kind !== "context") {
    const diff =
      line.kind === "del" ? wordDiff(line.text, counterpart) : wordDiff(counterpart, line.text);
    if (diff) marks = changedRanges(line.kind === "del" ? diff.old : diff.new);
  }

  return (
    <div
      className={`row-line kind-${line.kind}${selected ? " selected" : ""}${searchHit ? " search-flash" : ""}`}
    >
      <Gutter path={path} side="old" line={line.old_line} />
      <Gutter path={path} side="new" line={line.new_line} />
      <span className="sign">{sign}</span>
      <span className="code">
        <CodeText text={line.text} lang={lang} marks={marks} />
        {line.no_newline === true && <span className="no-newline"> ∅ no newline at EOF</span>}
      </span>
    </div>
  );
});
