import type { ReactElement } from "react";
import { memo } from "react";
import type { HunkHeaderInfo } from "../../lib/rows";

export const HunkHeaderRow = memo(function HunkHeaderRow({
  hunk,
}: {
  hunk: HunkHeaderInfo;
}): ReactElement {
  return (
    <div className="row-hunk">
      @@ -{hunk.old_start},{hunk.old_lines} +{hunk.new_start},{hunk.new_lines} @@
      {hunk.header ? ` ${hunk.header}` : ""}
    </div>
  );
});
