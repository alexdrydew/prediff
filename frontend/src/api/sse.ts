/**
 * Reconnecting SSE client for /events.
 *
 * EventSource reconnects on transient drops by itself; this wrapper adds
 * (a) recreation with exponential backoff when the browser gives up
 * (readyState CLOSED, e.g. daemon restarted), and (b) an onResync callback
 * fired on every re-established connection so the store can refetch state
 * it may have missed while offline.
 */

/** Event names the daemon broadcasts (src/server/events.ts). */
export const SERVER_EVENTS = [
  "revision",
  "comment.created",
  "comment.updated",
  "comment.resolved",
  "comment.deleted",
  "feedback.sent",
  "session.ready",
  "session.changed",
  "viewed.changed",
] as const;

export type ServerEventName = (typeof SERVER_EVENTS)[number];

export type ConnectionStatus = "connecting" | "online" | "offline";

export interface SseHandlers {
  onEvent: (name: ServerEventName, data: unknown) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Fired when a connection is re-established after a drop. */
  onResync?: () => void;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

/** Connect to `url`; returns a dispose function. */
export function connectEvents(url: string, handlers: SseHandlers): () => void {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let hadConnection = false;
  let disposed = false;

  const open = (): void => {
    if (disposed) return;
    handlers.onStatus?.("connecting");
    const es = new EventSource(url);
    source = es;

    es.onopen = () => {
      attempts = 0;
      handlers.onStatus?.("online");
      if (hadConnection) handlers.onResync?.();
      hadConnection = true;
    };

    for (const name of SERVER_EVENTS) {
      es.addEventListener(name, (event: MessageEvent<string>) => {
        let data: unknown = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          // malformed payload: still deliver the event name
        }
        handlers.onEvent(name, data);
      });
    }

    es.onerror = () => {
      if (disposed) return;
      handlers.onStatus?.("offline");
      if (es.readyState === EventSource.CLOSED) {
        // Browser gave up; recreate with backoff.
        es.close();
        source = null;
        attempts += 1;
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
        retryTimer = setTimeout(open, delay);
      }
      // CONNECTING: EventSource is retrying on its own; leave it alone.
    };
  };

  open();

  return () => {
    disposed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    source?.close();
  };
}
