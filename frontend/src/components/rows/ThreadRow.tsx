import type { ReactElement } from "react";
import { memo, useState } from "react";
import type { ReviewComment } from "../../types";
import { api } from "../../api/client";
import { removeComment, upsertComment } from "../../state/store";

export const ThreadRow = memo(function ThreadRow({
  comment,
  detached,
}: {
  comment: ReviewComment;
  detached: boolean;
}): ReactElement {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (op: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await op();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const range = comment.line === comment.end_line ? `${comment.line}` : `${comment.line}–${comment.end_line}`;

  return (
    <div className="row-thread">
      <div className={`thread state-${comment.state}`}>
        <div className="meta">
          <span className="state-label">{comment.state}</span>
          <span>
            {comment.file}:{range} ({comment.side})
          </span>
          {detached && <span title="Could not be placed on a visible diff line">detached</span>}
          <span>gen {comment.generation}</span>
        </div>
        <div className="body">{comment.text}</div>
        {comment.replies.map((reply, i) => (
          <div className="reply" key={i}>
            <span className="from">{reply.from}: </span>
            {reply.text}
          </div>
        ))}
        {replying && (
          <textarea
            rows={2}
            autoFocus
            placeholder="Reply…"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
          />
        )}
        <div className="actions">
          {replying ? (
            <>
              <button
                className="primary"
                disabled={busy || replyText.trim() === ""}
                onClick={() =>
                  void run(async () => {
                    upsertComment(await api.replyToComment(comment.id, replyText.trim()));
                    setReplyText("");
                    setReplying(false);
                  })
                }
              >
                Reply
              </button>
              <button disabled={busy} onClick={() => setReplying(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button disabled={busy} onClick={() => setReplying(true)}>
                Reply
              </button>
              {comment.state === "resolved" ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      upsertComment(await api.updateComment(comment.id, { state: "open" }));
                    })
                  }
                >
                  Reopen
                </button>
              ) : (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      upsertComment(await api.updateComment(comment.id, { state: "resolved" }));
                    })
                  }
                >
                  Resolve
                </button>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.deleteComment(comment.id);
                    removeComment(comment.id);
                  })
                }
              >
                Delete
              </button>
            </>
          )}
        </div>
        {error !== null && <div className="meta">error: {error}</div>}
      </div>
    </div>
  );
});
