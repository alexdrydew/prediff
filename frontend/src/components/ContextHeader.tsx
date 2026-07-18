import type { ReactElement } from "react";
/** Sticky context header (§6.2): "file — hunk N of M", always visible. */

import { expandContext, useStore } from "../state/store";

export function ContextHeader(): ReactElement {
  const path = useStore((s) => s.activePath);
  const hunk = useStore((s) => s.activeHunk);
  const historical = useStore(
    (s) => s.viewingRevision !== null && s.viewingRevision !== s.session?.revision,
  );

  const expandAround = (): void => {
    if (path === null || hunk === null) return;
    void expandContext(path, hunk.idx, "up");
    void expandContext(path, hunk.idx + 1, "down");
  };

  return (
    <div className="ctx">
      <span className="ctx-path">{path ?? "—"}</span>
      {hunk !== null && (
        <span className="ctx-hunk">
          hunk {hunk.idx + 1} of {hunk.count}
        </span>
      )}
      <span className="fill" />
      {path !== null && hunk !== null && !historical && (
        <button className="ctx-btn" onClick={expandAround} title="Reveal more surrounding code">
          Expand context
        </button>
      )}
    </div>
  );
}
