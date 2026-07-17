import type { ReactElement } from "react";
import { memo, useState } from "react";
import {
  closeComposer,
  setDraftText,
  submitComposer,
  useStore,
  type ComposerTarget,
} from "../../state/store";

export const ComposerRow = memo(function ComposerRow({
  target,
}: {
  target: ComposerTarget;
}): ReactElement {
  const text = useStore((s) => s.draftText[target.key] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range =
    target.line === target.end_line ? `${target.line}` : `${target.line}–${target.end_line}`;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await submitComposer(target.key);
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
          New comment on {target.file}:{range} ({target.side} side)
        </div>
        <textarea
          rows={3}
          autoFocus
          placeholder="Leave a comment for the agent…"
          value={text}
          onChange={(e) => setDraftText(target.key, e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
            if (e.key === "Escape") closeComposer(target.key);
          }}
        />
        <div className="actions">
          <button className="primary" disabled={busy || text.trim() === ""} onClick={() => void submit()}>
            Add comment
          </button>
          <button disabled={busy} onClick={() => closeComposer(target.key)}>
            Cancel
          </button>
        </div>
        {error !== null && <div className="target">error: {error}</div>}
      </div>
    </div>
  );
});
