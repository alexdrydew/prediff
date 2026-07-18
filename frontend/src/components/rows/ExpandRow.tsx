import type { ReactElement } from "react";
import { memo } from "react";
import type { GapInfo } from "../../lib/rows";
import { expandContext, useStore } from "../../state/store";

/** "Expand context" control between hunks (spec §3.2). Disabled while an
 * older revision is pinned — file content is only served for the latest. */
export const ExpandRow = memo(function ExpandRow({
  path,
  gap,
}: {
  path: string;
  gap: GapInfo;
}): ReactElement {
  const historical = useStore(
    (s) => s.viewingRevision !== null && s.viewingRevision !== s.session?.revision,
  );
  if (historical) {
    return (
      <div className="row-expand">
        <span>
          {gap.hidden !== null ? `${gap.hidden} unchanged lines` : "unchanged lines"} (expand
          available on the latest revision)
        </span>
      </div>
    );
  }
  const label =
    gap.hidden !== null
      ? `${gap.hidden} unchanged ${gap.hidden === 1 ? "line" : "lines"}`
      : "rest of file";
  return (
    <div className="row-expand">
      {gap.up && (
        <button
          title="Expand 20 lines above the next change"
          onClick={() => void expandContext(path, gap.index, "up")}
        >
          ⤒ Expand up
        </button>
      )}
      {gap.down && (
        <button
          title="Expand 20 lines below the previous change"
          onClick={() => void expandContext(path, gap.index, "down")}
        >
          ⤓ Expand down
        </button>
      )}
      <button title="Expand all hidden lines" onClick={() => void expandContext(path, gap.index, "all")}>
        Expand all
      </button>
      <span>{label}</span>
    </div>
  );
});
