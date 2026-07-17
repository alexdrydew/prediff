import type { ReactElement } from "react";
import { useState } from "react";
import { api } from "../api/client";
import { selectOpenCommentCount } from "../state/selectors";
import { collapseAll, setReviewState, setViewMode, useStore } from "../state/store";

export function Toolbar(): ReactElement {
  const manifest = useStore((s) => s.manifest);
  const session = useStore((s) => s.session);
  const connection = useStore((s) => s.connection);
  const viewMode = useStore((s) => s.viewMode);
  const openComments = useStore(selectOpenCommentCount);
  const [submitting, setSubmitting] = useState(false);

  const finishReview = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await api.submitReview();
      setReviewState("submitted"); // SSE will confirm; set eagerly for snappy UI
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="toolbar">
      <strong>prediff</strong>
      <span className="stats">
        {manifest
          ? `${manifest.range} · gen ${manifest.generation} · ${manifest.files.length} files `
          : "loading…"}
        {manifest && (
          <>
            <span className="stat-add">+{manifest.additions}</span>{" "}
            <span className="stat-del">−{manifest.deletions}</span>
          </>
        )}
      </span>
      <span className={`connection-dot ${connection}`} title={`SSE: ${connection}`} />
      <span className="spacer" />
      <button
        onClick={() => setViewMode(viewMode === "unified" ? "split" : "unified")}
        title="Toggle unified / side-by-side"
      >
        {viewMode === "unified" ? "Unified" : "Side-by-side"}
      </button>
      <button onClick={collapseAll}>Collapse all</button>
      <button onClick={() => void api.refresh()}>Refresh diff</button>
      <button
        className="primary"
        disabled={submitting || session?.review_state === "submitted"}
        onClick={() => void finishReview()}
      >
        Finish review{openComments > 0 ? ` (${openComments} open)` : ""}
      </button>
    </div>
  );
}
