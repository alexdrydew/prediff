import type { ReactElement } from "react";
import { TopBar } from "./components/TopBar";
import { FileTree } from "./components/FileTree";
import { Banners } from "./components/Banners";
import { InterdiffBar } from "./components/InterdiffBar";
import { ContextHeader } from "./components/ContextHeader";
import { DiffViewer } from "./components/DiffViewer";
import { KeyboardBar } from "./components/KeyboardBar";
import { Panels } from "./components/Panels";
import { SearchOverlay } from "./components/SearchOverlay";
import { DisconnectedOverlay, ReadyScreen } from "./components/Overlays";
import { useStore } from "./state/store";

export function App(): ReactElement {
  const loadError = useStore((s) => s.loadError);
  const hasManifest = useStore((s) => s.manifest !== null);
  const ready = useStore((s) => s.session?.session_state === "ready");

  return (
    <div className="app">
      <TopBar />
      <div className="body-row">
        <FileTree />
        <main className="mn">
          <Banners />
          {ready ? (
            <ReadyScreen />
          ) : loadError !== null && !hasManifest ? (
            <div className="load-error">Failed to load review: {loadError}</div>
          ) : (
            <>
              <InterdiffBar />
              <ContextHeader />
              <DiffViewer />
            </>
          )}
        </main>
      </div>
      <KeyboardBar />
      <SearchOverlay />
      <Panels />
      <DisconnectedOverlay />
    </div>
  );
}
