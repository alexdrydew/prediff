import type { ReactElement } from "react";
import { memo, useState } from "react";
import type { CommentTag } from "../../types";
import {
  closeReviewComposer,
  setReviewDraftText,
  submitReviewComposer,
  useStore,
} from "../../state/store";
import { TagChips } from "./ThreadRow";

const isMac = navigator.platform.toUpperCase().includes("MAC");

/**
 * Composer for a review-level comment (QA gap §1.1): plain textarea + tag
 * chips, no line anchor. Creates a draft about the change as a whole —
 * GitHub's review-summary equivalent.
 */
export const ReviewComposerRow = memo(function ReviewComposerRow(): ReactElement {
  const text = useStore((s) => s.reviewDraftText);
  const [tag, setTag] = useState<CommentTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (text.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await submitReviewComposer(tag);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <div className="row-composer">
      <div className="composer">
        <div className="target">Review comment — about the change as a whole (no line anchor)</div>
        <textarea
          rows={3}
          autoFocus
          placeholder="Overall feedback for the agent — approach, structure, direction… (Markdown supported)"
          value={text}
          onChange={(e) => setReviewDraftText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
            if (e.key === "Escape") closeReviewComposer();
          }}
        />
        <div className="actions" style={{ marginTop: 8 }}>
          <TagChips value={tag} onChange={setTag} />
        </div>
        <div className="actions">
          <button
            className="btn btn-p btn-sm"
            disabled={busy || text.trim() === ""}
            onClick={() => void submit()}
          >
            Add draft
          </button>
          <button className="btn btn-s btn-sm" disabled={busy} onClick={closeReviewComposer}>
            Cancel
          </button>
          <span className="hint">
            {isMac ? "⌘" : "Ctrl"}+Enter to save · Esc to cancel · drafts stay private until
            “Send Feedback”
          </span>
        </div>
        {error !== null && <div className="error">error: {error}</div>}
      </div>
    </div>
  );
});
