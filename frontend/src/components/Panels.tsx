import type { ReactElement } from "react";
/**
 * Top-bar panels: Send Feedback confirmation (§5.1, wireframe 2), Mark Ready
 * confirmation (§5.2), orphaned-comment triage list (§6.4, wireframe 5),
 * session history (§9.2, wireframe 6) and the keyboard-shortcut overlay (§8).
 */

import { useState } from "react";
import type { ReviewComment } from "../types";
import {
  applyRevision,
  beginReanchor,
  closePanel,
  convertToFileNote,
  dismissOrphan,
  markReady,
  sendFeedback,
  useStore,
} from "../state/store";
import { selectDraftCount, selectDrafts, selectOrphans, selectUnresolvedCount } from "../state/selectors";
import { scrollToPath } from "../state/controller";
import { timeAgo } from "../lib/timeago";
import { TagBadge } from "./rows/ThreadRow";

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function commentLoc(c: ReviewComment): string {
  if (c.file === null) return "review comment";
  return c.line === 0 ? `${c.file} (file note)` : `${c.file}:${c.line}`;
}

// ---------------------------------------------------------------------------

function SendFeedbackPanel(): ReactElement {
  const drafts = useStore(selectDrafts);
  const revision = useStore((s) => s.session?.revision ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await sendFeedback();
    } catch (err) {
      // Comments stay drafts — visible failure with retry (spec §9.7).
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <div className="panel" role="dialog" aria-label="Send feedback">
      <h2>Send feedback to agent?</h2>
      <div className="sub">
        This will submit {drafts.length} draft comment{drafts.length === 1 ? "" : "s"} and signal
        the agent to start Revision {revision + 1}.
      </div>
      <div className="panel-list">
        {drafts.map((c) => (
          <div className="panel-row" key={c.id}>
            <TagBadge tag={c.tag} />
            <span className="mono">{commentLoc(c)}</span>
            <span className="muted">{truncate(c.text, 48)}</span>
          </div>
        ))}
      </div>
      {error !== null && (
        <div className="panel-warning">
          <span className="mark">!</span>
          <div>
            <div className="title">Failed to send: {error}</div>
            <p className="sub">Your comments are still drafts. Nothing was lost — retry below.</p>
          </div>
        </div>
      )}
      <div className="panel-actions">
        <button className="btn btn-s" disabled={busy} onClick={closePanel}>
          Cancel
        </button>
        <button className="btn btn-p" disabled={busy || drafts.length === 0} onClick={() => void send()}>
          {error !== null ? "Retry — " : ""}Send {drafts.length} comment
          {drafts.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MarkReadyPanel(): ReactElement {
  const unresolved = useStore(selectUnresolvedCount);
  const drafts = useStore(selectDraftCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await markReady();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <div className="panel" role="dialog" aria-label="Mark ready">
      <h2>Mark this review as ready?</h2>
      <div className="sub">
        You're signaling that you're satisfied. The next step (pushing to GitHub) happens outside
        prediff.
      </div>
      {unresolved > 0 && (
        <div className="panel-warning">
          <span className="mark">!</span>
          <div>
            <div className="title">
              {unresolved} unresolved comment{unresolved === 1 ? "" : "s"} remain
              {unresolved === 1 ? "s" : ""}
              {drafts > 0 ? ` (${drafts} still draft${drafts === 1 ? "" : "s"})` : ""}
            </div>
            <p className="sub">You can still mark ready — this is a flag, not a blocker.</p>
          </div>
        </div>
      )}
      {error !== null && (
        <div className="panel-warning">
          <span className="mark">!</span>
          <div>
            <div className="title">Failed: {error}</div>
          </div>
        </div>
      )}
      <div className="panel-actions">
        <button className="btn btn-s" disabled={busy} onClick={closePanel}>
          Cancel
        </button>
        <button className="btn btn-p" disabled={busy} onClick={() => void confirm()}>
          Mark Ready
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AttentionPanel(): ReactElement {
  const orphans = useStore(selectOrphans);
  return (
    <div className="panel" role="dialog" aria-label="Needs your attention">
      <h2>Needs your attention</h2>
      <div className="sub">
        The code these comments were anchored to no longer exists in the current revision. They
        are never dropped silently — resolve each one below (spec §6.4).
      </div>
      {orphans.length === 0 && <div className="empty">Nothing needs attention. ✓</div>}
      {orphans.map((c) => (
        <div className="orphan-entry" key={c.id}>
          <div className="origin">
            <span className="badge badge-caution">Needs attention</span>{" "}
            <button
              style={{ color: "var(--accent-primary)" }}
              onClick={() => {
                if (c.file !== null) scrollToPath(c.file);
                closePanel();
              }}
            >
              {c.file ?? "review comment"}
            </button>{" "}
            — originally line {c.line}, Rev {c.revision}
          </div>
          <div className="text">“{c.text}”</div>
          <div className="actions">
            <button className="btn btn-s btn-sm" onClick={() => beginReanchor(c.id)}>
              Re-anchor to line…
            </button>
            <button className="btn btn-s btn-sm" onClick={() => void convertToFileNote(c.id)}>
              Convert to file note
            </button>
            <button className="btn btn-s btn-sm" onClick={() => void dismissOrphan(c.id)}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function HistoryPanel(): ReactElement {
  const list = useStore((s) => s.revisionList);
  const current = useStore((s) => s.session?.revision ?? null);
  const viewing = useStore((s) => s.viewingRevision);
  const shown = viewing ?? current;

  return (
    <div className="panel" role="dialog" aria-label="Session history">
      <h2>Session history</h2>
      <div className="sub">
        Revisions are numbered and never deleted (§9.2). Viewing an older revision never loses
        drafts or collapse state.
      </div>
      {list === null && <div className="empty">Loading…</div>}
      {list !== null && (
        <div className="panel-list">
          {[...list].reverse().map((r) => (
            <div className="panel-row" key={r.revision}>
              <span
                style={{
                  fontWeight: 600,
                  width: 52,
                  color:
                    r.revision === current ? "var(--accent-agent)" : "var(--text-secondary)",
                }}
              >
                Rev {r.revision}
              </span>
              {r.revision === current && <span className="badge badge-agent">Current</span>}
              {r.revision === shown && r.revision !== current && (
                <span className="badge badge-muted">Viewing</span>
              )}
              <span className="muted" style={{ flex: 1 }}>
                {r.files} file{r.files === 1 ? "" : "s"} · +{r.additions} −{r.deletions}
              </span>
              <span className="muted">{timeAgo(r.created_at)}</span>
              {r.revision !== shown && (
                <button
                  className="btn btn-s btn-sm"
                  onClick={() => {
                    void applyRevision(r.revision === current ? null : r.revision);
                    closePanel();
                  }}
                >
                  View
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ["j / k", "Next / previous hunk"],
  ["n / p", "Next / previous file"],
  ["c", "Comment on the current line/hunk"],
  ["⌘/Ctrl+Enter", "Submit the open comment composer"],
  ["Esc", "Cancel composer / close panel"],
  ["v", "Toggle “viewed” on the current file"],
  ["] / [", "Next / previous unresolved comment"],
  ["/", "Focus the file-tree filter"],
  ["d", "Toggle side-by-side / unified"],
  ["?", "This overlay"],
];

function ShortcutsOverlay(): ReactElement {
  return (
    <div className="shortcuts" role="dialog" aria-label="Keyboard shortcuts">
      <h2>Keyboard shortcuts</h2>
      <table>
        <tbody>
          {SHORTCUTS.map(([key, desc]) => (
            <tr key={key}>
              <td>
                {key.split(" / ").map((k, i) => (
                  <span key={k}>
                    {i > 0 && " / "}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
              <td>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Panels(): ReactElement | null {
  const panel = useStore((s) => s.panel);
  if (panel === "none") return null;
  return (
    <>
      <div className="scrim" onClick={closePanel} />
      {panel === "send" && <SendFeedbackPanel />}
      {panel === "ready" && <MarkReadyPanel />}
      {panel === "attention" && <AttentionPanel />}
      {panel === "history" && <HistoryPanel />}
      {panel === "shortcuts" && <ShortcutsOverlay />}
    </>
  );
}
