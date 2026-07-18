import type { ReactElement } from "react";
/**
 * Full-screen states: the Disconnected overlay (§6.5/§9.7 — unmissable, not
 * a toast; drafts are server-side + reconnect is automatic) and the
 * review-complete card (wireframe 2 post-completion state).
 */

import { loadServerState, reopenSession, setPanel, useStore } from "../state/store";

export function DisconnectedOverlay(): ReactElement | null {
  const offline = useStore((s) => s.connection === "offline");
  if (!offline) return null;
  return (
    <div className="disconnect">
      <div className="card">
        <div className="title">Connection lost</div>
        <div className="sub">The prediff server is unreachable.</div>
        <div className="note">
          All your drafts are saved. Reconnecting automatically…
        </div>
        <button className="btn btn-s" onClick={() => void loadServerState()}>
          Retry now
        </button>
      </div>
    </div>
  );
}

export function ReadyScreen(): ReactElement {
  return (
    <div className="ready-screen">
      <div className="card">
        <div className="title">Review complete</div>
        <div className="sub">
          You marked this review as ready. Push your changes to GitHub when you're set — that
          step happens outside prediff.
        </div>
        <div className="actions">
          <button className="btn btn-s" onClick={() => void reopenSession()}>
            Reopen review
          </button>
          <button className="btn btn-s" onClick={() => setPanel("history")}>
            View session history
          </button>
        </div>
      </div>
    </div>
  );
}
