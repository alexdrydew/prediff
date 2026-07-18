import { createRoot } from "react-dom/client";
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
createRoot(container).render(<App />);
