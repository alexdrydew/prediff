import { createRoot } from "react-dom/client";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { App } from "./App";
import { connectEvents } from "./api/sse";
import { applyServerEvent } from "./state/events";
import { initKeyboard } from "./state/keyboard";
import { initThemeState, loadServerState, setConnection, setTheme } from "./state/store";
import { initTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/app.css";

// Boot outside React: theme, keyboard, one SSE connection, one initial load.
initTheme(setTheme);
initThemeState();
initKeyboard();
void loadServerState();
connectEvents("/events", {
  onEvent: applyServerEvent,
  onStatus: setConnection,
  // Reconnected after a drop: reconcile whatever we missed.
  onResync: () => void loadServerState(),
});

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(
  <WorkerPoolContextProvider
    poolOptions={{
      workerFactory: () => new DiffsWorker(),
      poolSize: Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1)),
    }}
    highlighterOptions={{
      theme: { dark: "pierre-dark", light: "pierre-light" },
      lineDiffType: "word-alt",
      tokenizeMaxLineLength: 4_000,
      maxLineDiffLength: 1_000,
    }}
  >
    <App />
  </WorkerPoolContextProvider>,
);
