import type { ReactElement } from "react";
import { memo, useState } from "react";
import type { CommentTag, ReviewComment } from "../../types";
import {
  beginReanchor,
  convertToFileNote,
  deleteComment,
  dismissOrphan,
  editDraft,
  flushDraft,
  reopenComment,
  replyToComment,
  resolveComment,
  sendCommentNow,
} from "../../state/store";
import { timeAgo } from "../../lib/timeago";

export const TAGS: ReadonlyArray<{ value: CommentTag; label: string; cls: string }> = [
  { value: "must-fix", label: "Must fix", cls: "tag-mf" },
  { value: "suggestion", label: "Suggestion", cls: "tag-sg" },
  { value: "question", label: "Question", cls: "tag-q" },
  { value: "nit", label: "Nit", cls: "tag-nit" },
];

export function TagBadge({ tag }: { tag: CommentTag | null }): ReactElement | null {
  const info = TAGS.find((t) => t.value === tag);
  if (!info) return null;
  return <span className={`tag ${info.cls}`}>{info.label}</span>;
}

export function TagChips({
  value,
  onChange,
}: {
  value: CommentTag | null;
  onChange: (tag: CommentTag | null) => void;
}): ReactElement {
  return (
    <span className="chip-row">
      {TAGS.map((t) => (
        <button
          key={t.value}
          className={`chip${value === t.value ? " on" : ""}`}
          onClick={() => onChange(value === t.value ? null : t.value)}
        >
          {t.label}
        </button>
      ))}
    </span>
  );
}

/**
 * A concrete suggested change (QA gap §1.5) as a mini diff: the anchored
 * lines' current text vs the reviewer's exact replacement. Read-only; the
 * agent fetches it via `prediff suggestion <id>`.
 */
function SuggestionBlock({
  current,
  suggestion,
}: {
  current: readonly string[];
  suggestion: string;
}): ReactElement {
  const replacement = suggestion === "" ? [] : suggestion.split("\n");
  return (
    <div className="sugg">
      <div className="sugg-head">
        Suggested change
        {replacement.length === 0 && <span className="sugg-del-note">(removes the lines)</span>}
      </div>
      {current.map((t, i) => (
        <div className="sugg-line del" key={`d${i}`}>
          <span className="sign">−</span>
          <span className="txt">{t}</span>
        </div>
      ))}
      {replacement.map((t, i) => (
        <div className="sugg-line add" key={`a${i}`}>
          <span className="sign">+</span>
          <span className="txt">{t}</span>
        </div>
      ))}
    </div>
  );
}

const LIFE: Record<ReviewComment["state"], { cls: string; label: string }> = {
  draft: { cls: "life-draft", label: "Draft — not sent yet" },
  submitted: { cls: "life-sub", label: "Submitted" },
  addressed: { cls: "life-addr", label: "Agent responded — review this" },
  resolved: { cls: "life-res", label: "Resolved" },
  orphaned: { cls: "life-orphan", label: "Needs your attention" },
};

function Lifecycle({ state }: { state: ReviewComment["state"] }): ReactElement {
  const { cls, label } = LIFE[state];
  return (
    <span className={`life ${cls}`}>
      <span className="life-d" />
      {label}
    </span>
  );
}

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
  const [resolvedOpen, setResolvedOpen] = useState(false);

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

  // Resolved threads collapse to a single reopenable line (spec §4.2).
  if (comment.state === "resolved" && !resolvedOpen) {
    return (
      <div className="row-thread">
        <button className="cmt-resolved" onClick={() => setResolvedOpen(true)}>
          <span className="check">✓</span>
          <span>Resolved</span>
          <span className="preview">{comment.text}</span>
          <span>{loc(comment)}</span>
        </button>
      </div>
    );
  }

  const isDraft = comment.state === "draft";

  return (
    <div className="row-thread">
      <div className={`cmt-wrap state-${comment.state}`}>
        <div className="cmt">
          <div className="cmt-head">
            <div className="av av-u">Y</div>
            <span className="cmt-name">You</span>
            <TagBadge tag={comment.tag} />
            <span className="cmt-loc">{loc(comment)}</span>
            <span className="cmt-time">{timeAgo(comment.created_at)}</span>
            {detached && comment.state !== "orphaned" && comment.line !== 0 && (
              <span className="badge badge-muted" title="Not on a visible diff line">
                off-diff
              </span>
            )}
            <span className="fill" />
            <Lifecycle state={comment.state} />
          </div>

          {comment.state === "orphaned" && (
            <div className="cmt-body" style={{ paddingBottom: 4 }}>
              <span className="badge badge-caution">Needs attention</span>{" "}
              <span style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)" }}>
                Originally on line {comment.line}, Rev {comment.revision} — the code this was
                anchored to no longer exists.
              </span>
            </div>
          )}

          {isDraft ? (
            <div className="cmt-edit">
              <textarea
                rows={2}
                value={comment.text}
                onChange={(e) => editDraft(comment.id, { text: e.target.value })}
                placeholder="Draft comment (autosaves)…"
              />
              <div className="cmt-actions" style={{ paddingLeft: 0, marginTop: 8 }}>
                <TagChips
                  value={comment.tag}
                  onChange={(tag) => editDraft(comment.id, { tag })}
                />
                {comment.kind === "line" && (
                  <button
                    className={`chip${comment.suggestion !== null ? " on" : ""}`}
                    title="Write the exact replacement for the anchored lines — the agent can apply it verbatim"
                    onClick={() =>
                      editDraft(comment.id, {
                        suggestion:
                          comment.suggestion === null ? comment.anchor.lines.join("\n") : null,
                      })
                    }
                  >
                    Suggest change
                  </button>
                )}
              </div>
              {comment.suggestion !== null && (
                <div className="sugg-edit">
                  <div className="sugg-edit-head">
                    Replacement for the anchored line{comment.line === comment.end_line ? "" : "s"}{" "}
                    (autosaves; empty = delete)
                  </div>
                  <textarea
                    rows={Math.min(8, Math.max(2, comment.suggestion.split("\n").length))}
                    className="sugg-ta"
                    spellCheck={false}
                    value={comment.suggestion}
                    onChange={(e) => editDraft(comment.id, { suggestion: e.target.value })}
                  />
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="cmt-body">{comment.text}</div>
              {comment.suggestion !== null && comment.kind === "line" && (
                <SuggestionBlock current={comment.anchor.lines} suggestion={comment.suggestion} />
              )}
            </>
          )}

          <div className="cmt-actions">
            {isDraft && (
              <>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await flushDraft(comment.id);
                      await sendCommentNow(comment.id);
                    })
                  }
                >
                  Send now
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => void run(() => deleteComment(comment.id))}
                >
                  Delete
                </button>
              </>
            )}
            {(comment.state === "submitted" || comment.state === "addressed") && (
              <>
                <button
                  disabled={busy}
                  onClick={() => void run(() => resolveComment(comment.id))}
                >
                  Mark resolved
                </button>
                <button disabled={busy} onClick={() => setReplying((r) => !r)}>
                  Reply
                </button>
              </>
            )}
            {comment.state === "orphaned" && (
              <>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => beginReanchor(comment.id)}
                >
                  Re-anchor to line…
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void run(() => convertToFileNote(comment.id))}
                >
                  Convert to file note
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void run(() => dismissOrphan(comment.id))}
                >
                  Dismiss
                </button>
              </>
            )}
            {comment.state === "resolved" && (
              <>
                <button
                  disabled={busy}
                  onClick={() => void run(() => reopenComment(comment.id))}
                >
                  Reopen
                </button>
                <button disabled={busy} onClick={() => setResolvedOpen(false)}>
                  Collapse
                </button>
              </>
            )}
          </div>
          {error !== null && (
            <div className="cmt-actions" style={{ color: "var(--status-error)" }}>
              error: {error}
            </div>
          )}
        </div>

        {comment.replies.map((reply, i) =>
          reply.from === "agent" ? (
            <div className="cmt agent-r" key={i}>
              <div className="cmt-head">
                <div className="av av-a">A</div>
                <span className="cmt-name">Agent</span>
                <span className="cmt-time">{timeAgo(reply.created_at)}</span>
                <span className="fill" />
                {i === comment.replies.length - 1 && comment.state === "addressed" && (
                  <span className="life life-addr">
                    <span className="life-d" />
                    Addressed in Rev {comment.revision}
                  </span>
                )}
              </div>
              <div className="cmt-body">{reply.text}</div>
            </div>
          ) : (
            <div className="cmt" key={i}>
              <div className="cmt-head">
                <div className="av av-u">Y</div>
                <span className="cmt-name">You</span>
                <span className="cmt-time">{timeAgo(reply.created_at)}</span>
              </div>
              <div className="cmt-body">{reply.text}</div>
            </div>
          ),
        )}

        {replying && (
          <div className="cmt-reply-box">
            <textarea
              rows={2}
              autoFocus
              placeholder="Reply…"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && replyText.trim() !== "") {
                  void run(async () => {
                    await replyToComment(comment.id, replyText.trim());
                    setReplyText("");
                    setReplying(false);
                  });
                }
                if (e.key === "Escape") setReplying(false);
              }}
            />
            <div className="cmt-actions" style={{ paddingLeft: 0 }}>
              <button
                className="btn btn-sm"
                disabled={busy || replyText.trim() === ""}
                onClick={() =>
                  void run(async () => {
                    await replyToComment(comment.id, replyText.trim());
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

function loc(comment: ReviewComment): string {
  if (comment.file === null) return "Review comment";
  if (comment.line === 0) return `${comment.file} (file note)`;
  const range =
    comment.line === comment.end_line
      ? `${comment.line}`
      : `${comment.line}–${comment.end_line}`;
  return `${comment.file}:${range}${comment.side === "old" ? " (old)" : ""}`;
}
