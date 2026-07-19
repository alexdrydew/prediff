import type { ReactElement } from "react";
/**
 * Header of the interdiff mode (QA gap §1.4): a clear "Rev N → Rev M" frame
 * around the comparison view, with the read-only note and the exit path back
 * to the normal review.
 */

import { closeInterdiff, useStore } from "../state/store";

export function InterdiffBar(): ReactElement | null {
  const mode = useStore((s) => s.interdiff);
  if (mode === null) return null;

  const manifest = mode.manifest;
  return (
    <div className="interdiff-bar" role="status">
      <span className="idb-title">
        What changed · Rev {mode.from} → Rev {mode.to}
      </span>
      {mode.status === "loading" && <span className="idb-sub">computing…</span>}
      {mode.status === "error" && (
        <span className="idb-err">failed to load: {mode.error ?? "unknown error"}</span>
      )}
      {mode.status === "ready" && manifest !== null && (
        <span className="idb-sub">
          {manifest.files.length === 0
            ? "no content changes between these revisions"
            : `${manifest.files.length} file${manifest.files.length === 1 ? "" : "s"} · +${manifest.additions} −${manifest.deletions}`}
        </span>
      )}
      <span className="idb-note">read-only — commenting is disabled in this view</span>
      <span className="fill" />
      <button className="btn btn-sm idb-exit" onClick={closeInterdiff} title="Back to the normal diff view (Esc)">
        Exit comparison
      </button>
    </div>
  );
}
