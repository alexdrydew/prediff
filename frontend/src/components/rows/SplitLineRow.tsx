import type { ReactElement } from "react";
import { memo } from "react";
import type { HunkLine, Side } from "../../types";
import type { PairedLine } from "../../lib/pairing";
import { beginSelection, extendSelection, useStore } from "../../state/store";
import { CodeText } from "./CodeText";

function Pane({
  path,
  side,
  line,
  lang,
}: {
  path: string;
  side: Side;
  line: HunkLine | null;
  lang: string | null;
}): ReactElement {
  const lineNo = line === null ? null : side === "old" ? line.old_line : line.new_line;
  const selected = useStore((s) => {
    const sel = s.selection;
    if (!sel || lineNo === null || sel.file !== path || sel.side !== side) return false;
    return lineNo >= Math.min(sel.anchor, sel.head) && lineNo <= Math.max(sel.anchor, sel.head);
  });
  if (line === null || lineNo === null) {
    return <span className="side empty" />;
  }
  // In split view a change pane only colors its own side.
  const kind = line.kind === "context" ? "context" : side === "old" ? "del" : "add";
  return (
    <span className={`side kind-${kind}${selected ? " selected" : ""}`}>
      <span
        className="gutter"
        title="Comment on this line (drag for a range)"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          beginSelection(path, side, lineNo);
        }}
        onMouseEnter={() => extendSelection(path, side, lineNo)}
      >
        {lineNo}
      </span>
      <span className="code" title={line.text}>
        <CodeText text={line.text} lang={lang} />
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
  return (
    <div className="row-split">
      <Pane path={path} side="old" line={pair.left} lang={lang} />
      <Pane path={path} side="new" line={pair.right} lang={lang} />
    </div>
  );
});
