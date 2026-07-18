import type { ReactElement } from "react";
import { memo } from "react";
import type { HunkHeaderInfo } from "../../lib/rows";

export const HunkHeaderRow = memo(function HunkHeaderRow({
  hunk,
  hunkIdx,
  hunkCount,
}: {
  hunk: HunkHeaderInfo;
  hunkIdx: number;
  hunkCount: number;
}): ReactElement {
  return (
    <div className="row-hunk">
      <span>
        @@ -{hunk.old_start},{hunk.old_lines} +{hunk.new_start},{hunk.new_lines} @@
      </span>
      {hunk.header !== "" && <span className="heading">{hunk.header}</span>}
      <span className="fill" />
      <span className="heading">
        hunk {hunkIdx + 1} of {hunkCount}
      </span>
    </div>
  );
});
