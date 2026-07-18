import type { ReactElement } from "react";
/** Dismissible keyboard hint strip (spec §1); full overlay on `?` (§8). */

import { dismissKbar, setPanel, useStore } from "../state/store";

export function KeyboardBar(): ReactElement | null {
  const dismissed = useStore((s) => s.kbarDismissed);
  if (dismissed) return null;
  return (
    <div className="kbar">
      <div className="kh">
        <kbd>j</kbd>
        <kbd>k</kbd> hunks
      </div>
      <div className="kh">
        <kbd>n</kbd>
        <kbd>p</kbd> files
      </div>
      <div className="kh">
        <kbd>c</kbd> comment
      </div>
      <div className="kh">
        <kbd>v</kbd> viewed
      </div>
      <div className="kh">
        <kbd>]</kbd>
        <kbd>[</kbd> comments
      </div>
      <div className="kh">
        <kbd>d</kbd> view
      </div>
      <div className="kh">
        <kbd>/</kbd> filter
      </div>
      <span className="fill" />
      <button className="kh" onClick={() => setPanel("shortcuts")} style={{ cursor: "pointer" }}>
        <kbd>?</kbd> all shortcuts
      </button>
      <button className="kbar-close" onClick={dismissKbar} title="Hide hint strip">
        ✕
      </button>
    </div>
  );
}
