import type { ReactElement } from "react";
import { Toolbar } from "./components/Toolbar";
import { DiffViewer } from "./components/DiffViewer";
import { useStore } from "./state/store";

export function App(): ReactElement {
  const loadError = useStore((s) => s.loadError);
  const submitted = useStore((s) => s.session?.review_state === "submitted");
  const hasManifest = useStore((s) => s.manifest !== null);

  return (
    <div className="app">
      <Toolbar />
      {submitted && (
        <div className="banner-submitted">
          Review submitted — the agent has been notified. Adding more comments reopens the
          conversation.
        </div>
      )}
      {loadError !== null && !hasManifest ? (
        <div className="load-error">Failed to load review: {loadError}</div>
      ) : (
        <DiffViewer />
      )}
    </div>
  );
}
