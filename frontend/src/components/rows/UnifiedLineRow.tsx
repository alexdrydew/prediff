import type { ReactElement } from "react";
import { memo } from "react";
import type { HunkLine, Side } from "../../types";
import {
  beginSelection,
  extendSelection,
  useStore,
  type LineSelection,
} from "../../state/store";
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
        beginSelection(path, side, line);
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
}: {
  path: string;
  line: HunkLine;
  lang: string | null;
}): ReactElement {
  const selected = useStore(
    (s) =>
      inSelection(s.selection, path, "old", line.old_line) ||
      inSelection(s.selection, path, "new", line.new_line),
  );
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  return (
    <div className={`row-line kind-${line.kind}${selected ? " selected" : ""}`}>
      <Gutter path={path} side="old" line={line.old_line} />
      <Gutter path={path} side="new" line={line.new_line} />
      <span className="sign">{sign}</span>
      <span className="code">
        <CodeText text={line.text} lang={lang} />
        {line.no_newline === true && <span className="no-newline"> ⛔ no newline at EOF</span>}
      </span>
    </div>
  );
});
