import type { ReactElement } from "react";
import {
  selectDraftCount,
  selectOrphanCount,
  selectSyncStatus,
  selectTree,
  selectUnresolvedCount,
} from "../state/selectors";
import {
  clearSyncError,
  loadServerState,
  openPanel,
  openReviewComposer,
  setPanel,
  setTheme,
  setViewMode,
  useStore,
} from "../state/store";
import { scrollToRow } from "../state/controller";
import { toggleTheme } from "../lib/theme";

const SYNC_LABEL: Record<string, string> = {
  synced: "Synced",
  saving: "Saving…",
  "agent-revising": "Agent is revising",
  offline: "Offline — reconnecting",
  error: "Sync failed",
};

function Logo(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2" y="2" width="14" height="14" rx="3.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="5.5" width="2" height="7" rx=".5" fill="currentColor" opacity=".65" />
      <rect x="10" y="7.5" width="2" height="5" rx=".5" fill="currentColor" opacity=".65" />
    </svg>
  );
}

/** Revision spine (the comp's signature element): a glanceable timeline of
 * the session's revisions. Click opens the history panel (§9.2). */
function RevisionSpine(): ReactElement | null {
  const session = useStore((s) => s.session);
  const viewing = useStore((s) => s.viewingRevision);
  const pending = useStore((s) => s.pendingRevision);
  if (!session) return null;
  const latest = Math.max(session.revision, pending ?? 0);
  const shown = viewing ?? session.revision;
  const MAX_DOTS = 5;
  const first = Math.max(1, latest - MAX_DOTS + 1);
  const dots: ReactElement[] = [];
  for (let r = first; r <= latest; r++) {
    if (r > first) {
      dots.push(<span key={`l${r}`} className={`spine-l${r > shown ? " dsh" : ""}`} />);
    }
    const cls = r === shown ? "cur" : r < shown ? "done hc" : "nxt";
    dots.push(<span key={r} className={`spine-n ${cls}`} title={`Revision ${r}`} />);
  }
  return (
    <button
      className="spine"
      onClick={() => setPanel("history")}
      title="Session history — revisions"
    >
      {dots}
      <span className="spine-lb">
        Rev {shown} / {latest}
      </span>
    </button>
  );
}

function SyncIndicator(): ReactElement {
  const status = useStore(selectSyncStatus);
  return (
    <span className={`sync ${status}`} role="status">
      <span className="sync-d" />
      {SYNC_LABEL[status]}
      {status === "error" && (
        <button
          onClick={() => {
            clearSyncError();
            void loadServerState();
          }}
        >
          retry
        </button>
      )}
    </span>
  );
}

function ThemeToggle(): ReactElement {
  const theme = useStore((s) => s.theme);
  return (
    <button
      className="icon-btn"
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => toggleTheme(setTheme)}
    >
      {theme === "dark" ? (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M13.5 8.5a5.5 5.5 0 1 1-7-5.2A4.5 4.5 0 0 0 13.5 8.5z" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="3.5" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
        </svg>
      )}
    </button>
  );
}

export function TopBar(): ReactElement {
  const session = useStore((s) => s.session);
  const viewMode = useStore((s) => s.viewMode);
  const drafts = useStore(selectDraftCount);
  const unresolved = useStore(selectUnresolvedCount);
  const orphans = useStore(selectOrphanCount);
  const commentCount = useStore((s) => s.comments.length);
  const tree = useStore(selectTree);
  const ready = session?.session_state === "ready";

  return (
    <div className="topbar">
      <div className="tb-logo">
        <Logo />
        prediff
      </div>
      <div className="tb-sep" />
      <span className="tb-session" title={`Diff range: ${session?.range ?? ""}`}>
        {session?.range ?? "…"}
      </span>
      {session?.scope != null && session.scope !== "" && (
        <span className="tb-scope" title={`Agent's stated scope: ${session.scope}`}>
          scope: {session.scope}
        </span>
      )}
      <RevisionSpine />
      <SyncIndicator />
      {orphans > 0 && (
        <button
          className="badge badge-caution attn-badge"
          onClick={() => setPanel("attention")}
          title="Stale/orphaned comments to triage"
        >
          {orphans} need{orphans === 1 ? "s" : ""} attention
        </button>
      )}
      <span className="fill" />
      <div className="toggle" role="group" aria-label="Diff layout">
        <button
          className={viewMode === "split" ? "on" : ""}
          onClick={() => setViewMode("split")}
        >
          Side-by-side
        </button>
        <button
          className={viewMode === "unified" ? "on" : ""}
          onClick={() => setViewMode("unified")}
        >
          Unified
        </button>
      </div>
      <div className="prog">
        <span>
          {tree.viewedFiles} / {tree.totalFiles} viewed
        </span>
        {commentCount > 0 && (
          <>
            <span className="prog-sep" />
            {unresolved > 0 ? (
              <span className="warn">{unresolved} unresolved</span>
            ) : (
              <span className="ok">All resolved</span>
            )}
          </>
        )}
      </div>
      <ThemeToggle />
      <button
        className="btn btn-s"
        disabled={ready}
        title="Comment on the change as a whole — no line anchor (like a GitHub review summary)"
        onClick={() => {
          openReviewComposer();
          scrollToRow(0);
        }}
      >
        Review comment
      </button>
      <button
        className="btn btn-s"
        disabled={ready}
        title={
          ready
            ? "Session already marked ready"
            : "Signal you're satisfied — pushing happens outside prediff"
        }
        onClick={() => openPanel("ready")}
      >
        Mark Ready
      </button>
      <button
        className="btn btn-p"
        disabled={drafts === 0}
        title={
          drafts === 0
            ? "No draft comments to send"
            : `Send ${drafts} draft comment${drafts === 1 ? "" : "s"} to the agent`
        }
        onClick={() => openPanel("send")}
      >
        Send Feedback{drafts > 0 ? ` (${drafts})` : ""}
      </button>
    </div>
  );
}
