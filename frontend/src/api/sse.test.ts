/**
 * Reconnect semantics of the SSE wrapper (QA F1 follow-through): a FULL
 * daemon restart means a brand-new event stream — everything broadcast in
 * between is gone — so the client must fire onResync (→ refetch manifest +
 * session) on every re-established connection, including after the browser
 * gave up (readyState CLOSED) and the wrapper recreated the EventSource.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connectEvents, type ConnectionStatus } from "./sse";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (event: MessageEvent<string>) => void): void {
    this.listeners.set(name, fn);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  /** Simulate the browser giving up (daemon down long enough). */
  emitFatalError(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

describe("connectEvents reconnect → resync", () => {
  test("daemon restart: recreated connection fires onResync so state is refetched", async () => {
    let resyncs = 0;
    const statuses: ConnectionStatus[] = [];
    const dispose = connectEvents("/events", {
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      onResync: () => {
        resyncs++;
      },
    });

    // Initial connection: online, but NOT a resync (nothing was missed).
    const first = FakeEventSource.instances[0]!;
    first.emitOpen();
    expect(resyncs).toBe(0);
    expect(statuses).toEqual(["connecting", "online"]);

    // Daemon dies; the browser gives up entirely (readyState CLOSED).
    first.emitFatalError();
    expect(statuses.at(-1)).toBe("offline");

    // The wrapper recreates the EventSource after backoff (1s first attempt).
    await Bun.sleep(1_100);
    expect(FakeEventSource.instances.length).toBe(2);

    // New daemon (same port) accepts the connection: this is a NEW event
    // stream, so the wrapper must request a full state resync.
    const second = FakeEventSource.instances[1]!;
    second.emitOpen();
    expect(resyncs).toBe(1);
    expect(statuses.at(-1)).toBe("online");

    dispose();
    expect(second.closed).toBe(true);
  }, 10_000);

  test("dispose during backoff stops reconnecting", async () => {
    const dispose = connectEvents("/events", { onEvent: () => {} });
    const first = FakeEventSource.instances[0]!;
    first.emitOpen();
    first.emitFatalError();
    dispose();
    await Bun.sleep(1_100);
    expect(FakeEventSource.instances.length).toBe(1);
  }, 10_000);
});
