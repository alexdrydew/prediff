import type { ReactElement } from "react";
/**
 * The non-blocking banner stack at the top of the diff panel: new-revision
 * arrival (§6.1 — never auto-applied), agent-working state, viewing-older
 * notice, sync failures (§9.7), and re-anchor mode (§6.4).
 */

import {
  applyRevision,
  cancelReanchor,
  clearSyncError,
  dismissPendingRevision,
  loadServerState,
  useStore,
} from "../state/store";

export function Banners(): ReactElement {
  const pending = useStore((s) => s.pendingRevision);
  const viewing = useStore((s) => s.viewingRevision);
  const latest = useStore((s) => s.session?.revision ?? null);
  const agentRevising = useStore((s) => s.agentRevising);
  const syncError = useStore((s) => s.syncError);
  const reanchoring = useStore((s) => s.reanchoring);
  const comment = useStore((s) =>
    s.reanchoring === null ? null : (s.comments.find((c) => c.id === s.reanchoring) ?? null),
  );

  const shown = viewing ?? latest;
  const viewingOlder = pending === null && viewing !== null && latest !== null && viewing < latest;

  return (
    <>
      {pending !== null && (
        <div className="rev-banner" role="status">
          <b>Agent pushed Revision {pending}</b>
          <span className="sub">— your view hasn't changed; switch when you're ready.</span>
          <span className="fill" />
          <button className="btn btn-sm rev-go" onClick={() => void applyRevision(null)}>
            Review now
          </button>
          <button className="btn btn-sm rev-stay" onClick={dismissPendingRevision}>
            Keep reviewing Rev {shown}
          </button>
        </div>
      )}
      {viewingOlder && (
        <div className="caution-banner" role="status">
          <span>
            Viewing Revision {viewing} — the latest is Revision {latest}.
          </span>
          <span className="fill" />
          <button className="btn btn-sm rev-stay" onClick={() => void applyRevision(null)}>
            Go to latest
          </button>
        </div>
      )}
      {agentRevising && pending === null && (
        <div className="agent-banner" role="status">
          <span className="mock-dot" />
          Agent is working on a new revision…
          <span className="fill" />
          <span className="sub">You can keep reviewing while the agent works.</span>
        </div>
      )}
      {syncError !== null && (
        <div className="error-banner" role="alert">
          <div>
            <div className="title">Sync failed: {syncError}</div>
            <div className="sub">
              Your comments are safe as drafts — nothing was lost. Retry when ready.
            </div>
          </div>
          <span className="fill" />
          <button
            className="btn btn-sm btn-retry"
            onClick={() => {
              clearSyncError();
              void loadServerState();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {reanchoring !== null && (
        <div className="caution-banner" role="status">
          <span>
            Re-anchoring{comment ? ` “${truncate(comment.text, 60)}”` : " comment"} — click a
            line number in the diff to place it.
          </span>
          <span className="fill" />
          <button className="btn btn-sm rev-stay" onClick={cancelReanchor}>
            Cancel (Esc)
          </button>
        </div>
      )}
    </>
  );
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}
