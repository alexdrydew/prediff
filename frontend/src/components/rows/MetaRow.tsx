import type { ReactElement } from "react";
import { memo } from "react";
import type { MetaVariant } from "../../lib/rows";
import { loadFileDiff } from "../../state/store";

export const MetaRow = memo(function MetaRow({
  path,
  variant,
  message,
}: {
  path: string;
  variant: MetaVariant;
  message?: string | undefined;
}): ReactElement {
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
      return (
        <div className="row-meta">
          large diff withheld for speed
          <button onClick={() => void loadFileDiff(path, { force: true })}>Load anyway</button>
        </div>
      );
  }
});
