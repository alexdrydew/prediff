import type { ReactElement } from "react";
import { memo, useState } from "react";
import type { CommentTag } from "../../types";
import { api } from "../../api/client";
import {
  closeComposer,
  setDraftText,
  store,
  submitComposer,
  useStore,
  type ComposerTarget,
} from "../../state/store";
import { suggestionPrefill } from "../../lib/suggestion";
import { TagChips } from "./ThreadRow";

const isMac = navigator.platform.toUpperCase().includes("MAC");

/** Current text of the anchored lines, from local state or the daemon. */
async function currentLinesText(target: ComposerTarget): Promise<string> {
  const s = store.getState();
  const local = suggestionPrefill(
    s.fileDiffs[target.file]?.diff?.hunks,
    target.side === "new" ? s.contextContent[target.file] : undefined,
    target.side,
    target.line,
    target.end_line,
  );
  if (local !== null) return local;
  try {
    const content = await api.fileContent(target.file, target.side);
    return content.lines.slice(target.line - 1, target.end_line).join("\n");
  } catch {
    return ""; // still usable — the reviewer types the replacement from scratch
  }
}

export const ComposerRow = memo(function ComposerRow({
  target,
}: {
  target: ComposerTarget;
}): ReactElement {
  const text = useStore((s) => s.draftText[target.key] ?? "");
  const [tag, setTag] = useState<CommentTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Null = "Suggest change" off; string = replacement text (§1.5). */
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const range =
    target.line === target.end_line ? `${target.line}` : `${target.line}–${target.end_line}`;

  const toggleSuggest = async (): Promise<void> => {
    if (suggestion !== null) {
      setSuggestion(null);
      return;
    }
    setSuggestion(await currentLinesText(target));
  };

  const submit = async (): Promise<void> => {
    if (text.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await submitComposer(target.key, tag, suggestion);
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
          <button
            className={`chip${suggestion !== null ? " on" : ""}`}
            title="Write the exact replacement for the anchored lines — the agent can apply it verbatim"
            onClick={() => void toggleSuggest()}
          >
            Suggest change
          </button>
        </div>
        {suggestion !== null && (
          <div className="sugg-edit">
            <div className="sugg-edit-head">
              Replacement for line{target.line === target.end_line ? "" : "s"} {range} (prefilled
              with the current text; empty = delete)
            </div>
            <textarea
              rows={Math.min(8, Math.max(2, suggestion.split("\n").length))}
              className="sugg-ta"
              spellCheck={false}
              value={suggestion}
              onChange={(e) => setSuggestion(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
              }}
            />
          </div>
        )}
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
