import type { ReactElement } from "react";
import { memo, useState } from "react";
import type { CommentTag } from "../../types";
import {
  closeComposer,
  setDraftText,
  submitComposer,
  useStore,
  type ComposerTarget,
} from "../../state/store";
import { TagChips } from "./ThreadRow";

const isMac = navigator.platform.toUpperCase().includes("MAC");

export const ComposerRow = memo(function ComposerRow({
  target,
}: {
  target: ComposerTarget;
}): ReactElement {
  const text = useStore((s) => s.draftText[target.key] ?? "");
  const [tag, setTag] = useState<CommentTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range =
    target.line === target.end_line ? `${target.line}` : `${target.line}–${target.end_line}`;

  const submit = async (): Promise<void> => {
    if (text.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await submitComposer(target.key, tag);
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
        <div className="target">
          {target.file}:{range}
          {target.side === "old" ? " (old side)" : ""}
        </div>
        <textarea
          rows={3}
          autoFocus
          placeholder="Leave a comment for the agent… (Markdown supported)"
          value={text}
          onChange={(e) => setDraftText(target.key, e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
            if (e.key === "Escape") closeComposer(target.key);
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
          <button className="btn btn-s btn-sm" disabled={busy} onClick={() => closeComposer(target.key)}>
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
