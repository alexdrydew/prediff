/** SSE hub: fan-out of server events to browser tabs (and anything else). */

export type EventName =
  | "generation"
  | "comment.created"
  | "comment.updated"
  | "comment.resolved"
  | "comment.deleted"
  | "review.submitted"
  | "session.changed";

interface Client {
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const encoder = new TextEncoder();

export class EventHub {
  private clients = new Set<Client>();
  private listeners = new Set<(event: EventName, data: unknown) => void>();

  /** Server-internal subscription (used by /api/wait long-poll). */
  onEvent(fn: (event: EventName, data: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(event: EventName, data: unknown): void {
    const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const client of this.clients) {
      try {
        client.controller.enqueue(payload);
      } catch {
        this.clients.delete(client);
      }
    }
    for (const fn of this.listeners) fn(event, data);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Build an SSE Response for a new subscriber. */
  sseResponse(signal: AbortSignal): Response {
    const clients = this.clients;
    let client: Client;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = { controller };
        clients.add(client);
        controller.enqueue(encoder.encode(`retry: 1000\n\n`));
        signal.addEventListener("abort", () => {
          clients.delete(client);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        clients.delete(client);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
}
