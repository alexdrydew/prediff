import type { ReactElement } from "react";
import { memo } from "react";
import type { HunkLine, Side } from "../../types";
import { extendSelection, useStore } from "../../state/store";
import type { PairedLine } from "../../lib/pairing";
import { changedRanges, wordDiff, type WordDiff } from "../../lib/wordDiff";
import { CodeText } from "./CodeText";
import { gutterMouseDown } from "./UnifiedLineRow";

function Pane({
  path,
  side,
  line,
  lang,
  diff,
}: {
  path: string;
  side: Side;
  line: HunkLine | null;
  lang: string | null;
  diff: WordDiff | null;
}): ReactElement {
  const lineNo = line === null ? null : side === "old" ? line.old_line : line.new_line;
  const selected = useStore((s) => {
    const sel = s.selection;
    if (!sel || lineNo === null || sel.file !== path || sel.side !== side) return false;
    return lineNo >= Math.min(sel.anchor, sel.head) && lineNo <= Math.max(sel.anchor, sel.head);
  });
  if (line === null || lineNo === null) {
    return (
      <span className="side empty">
        <span className="gutter" />
        <span className="code" />
      </span>
    );
  }
  // In split view a change pane only colors its own side.
  const kind = line.kind === "context" ? "context" : side === "old" ? "del" : "add";
  const marks =
    diff !== null ? changedRanges(side === "old" ? diff.old : diff.new) : undefined;
  return (
    <span className={`side kind-${kind}${selected ? " selected" : ""}`}>
      <span
        className="gutter"
        title="Comment on this line (drag for a range)"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          gutterMouseDown(path, side, lineNo);
        }}
        onMouseEnter={() => extendSelection(path, side, lineNo)}
      >
        {lineNo}
      </span>
      <span className="code" title={line.text}>
        <CodeText text={line.text} lang={lang} marks={marks} />
      </span>
    </span>
  );
}

export const SplitLineRow = memo(function SplitLineRow({
  path,
  pair,
  lang,
}: {
  path: string;
  pair: PairedLine;
  lang: string | null;
}): ReactElement {
  // Word-level marks only when a deletion is paired with an addition (§3.2).
  const paired =
    pair.left !== null &&
    pair.right !== null &&
    pair.left !== pair.right &&
    pair.left.kind === "del" &&
    pair.right.kind === "add";
  const diff = paired ? wordDiff(pair.left!.text, pair.right!.text) : null;
  return (
    <div className="row-split">
      <Pane path={path} side="old" line={pair.left} lang={lang} diff={diff} />
      <Pane path={path} side="new" line={pair.right} lang={lang} diff={diff} />
    </div>
  );
});
