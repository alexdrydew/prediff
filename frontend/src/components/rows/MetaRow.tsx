import type { ReactElement } from "react";
import { memo, useEffect } from "react";
import type { MetaVariant } from "../../lib/rows";
import { loadFileDiff } from "../../state/store";

export const MetaRow = memo(function MetaRow({
  path,
  variant,
  message,
  lines,
}: {
  path: string;
  variant: MetaVariant;
  message?: string | undefined;
  lines?: number | undefined;
}): ReactElement {
  // Files are expanded by default but their hunks load lazily: this row only
  // mounts when it scrolls into the virtualizer window, so kicking the fetch
  // here gives render-on-demand for free (spec §7.4).
  useEffect(() => {
    if (variant === "loading") void loadFileDiff(path);
  }, [variant, path]);

  switch (variant) {
    case "binary":
      return <div className="row-meta">binary file — no textual diff</div>;
    case "loading":
      return <div className="row-meta">loading hunks…</div>;
    case "empty":
      return <div className="row-meta">no textual changes</div>;
    case "error":
      return (
        <div className="row-meta">
          failed to load: {message ?? "unknown error"}
          <button onClick={() => void loadFileDiff(path, { force: true })}>Retry</button>
        </div>
      );
    case "large":
      // Deliberate protective choice, so say so (QA §2.5): the first
      // encounter must read as "on purpose", not "the diff failed to load".
      return (
        <div className="row-meta">
          <span>
            Large diff{lines !== undefined ? ` (${lines.toLocaleString("en-US")} changed lines)` : ""}{" "}
            withheld for speed —
          </span>
          <button onClick={() => void loadFileDiff(path, { force: true })}>Load anyway</button>
          <span className="meta-note">Files over 5,000 changed lines load on demand.</span>
        </div>
      );
    case "unavailable":
      return (
        <div className="row-meta">interdiff not available — {message ?? "content not recorded"}</div>
      );
  }
});
