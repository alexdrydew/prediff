import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connectEvents } from "./api/sse";
import { applyServerEvent } from "./state/events";
import { loadServerState, setConnection } from "./state/store";
import "./styles/tokens.css";
import "./styles/app.css";

// Boot outside React: one SSE connection and one initial load per page.
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
