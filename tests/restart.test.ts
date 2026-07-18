/**
 * Daemon restart semantics (QA F1): a restarted daemon must rebind the port
 * of the previous run so already-open browser tabs — whose reconnect loop
 * polls the old origin — come back automatically. Falls back to a random
 * port (updating the stored one) only when the preferred port is taken.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReviewComment, Session } from "../src/types";
import { Daemon } from "../src/server/server";
import { readPreferredPort } from "../src/server/lockfile";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

let repo: string;
let stateDir: string;

beforeAll(async () => {
  repo = await initRepo();
  stateDir = await tempDir("state");
  await write(repo, "a.txt", "one\ntwo\nthree\n");
  await commitAll(repo, "base");
  await write(repo, "a.txt", "one\nTWO\nthree\n");
});

afterAll(async () => {
  await cleanup(repo, stateDir);
});

function makeDaemon(port?: number): Daemon {
  return new Daemon({
    repoRoot: repo,
    stateDir,
    range: "working",
    ttlMs: 0,
    ...(port !== undefined ? { port } : {}),
  });
}

describe("daemon restart keeps the port (QA F1)", () => {
  test("stop + start rebinds the same port, and the old origin serves the same session", async () => {
    const first = makeDaemon();
    await first.start();
    const url = first.url;
    const port = Number(new URL(url).port);
    expect(await readPreferredPort(stateDir)).toBe(port);

    // A browser tab knows this session by its origin; record what it saw.
    const before = (await (await fetch(new URL("/api/session", url))).json()) as Session;
    const comment = (await (
      await fetch(new URL("/api/comments", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "a.txt", line: 2, text: "check this" }),
      })
    ).json()) as ReviewComment;
    expect(comment.id).toBeTruthy();

    await first.close();
    // Daemon gone: the old origin is dark (what stranded tabs used to see).
    await expect(fetch(new URL("/api/health", url))).rejects.toThrow();

    const second = makeDaemon();
    await second.start();
    try {
      // Same port — the tab's reconnect loop works without a new URL.
      expect(second.url).toBe(url);
      const after = (await (await fetch(new URL("/api/session", url))).json()) as Session;
      expect(after.session_id).toBe(before.session_id);
      expect(after.comments.map((c) => c.id)).toContain(comment.id);
    } finally {
      await second.close();
    }
  });

  test("falls back to a random port when the preferred one is taken, and persists the new one", async () => {
    const preferred = await readPreferredPort(stateDir);
    expect(preferred).not.toBeNull();
    // Squat on the preferred port.
    const squatter = Bun.serve({
      port: preferred!,
      hostname: "127.0.0.1",
      fetch: () => new Response("squatter"),
    });
    const daemon = makeDaemon();
    try {
      await daemon.start();
      const port = Number(new URL(daemon.url).port);
      expect(port).not.toBe(preferred);
      expect(port).toBeGreaterThan(0);
      // The stored port follows, so the NEXT restart is stable again.
      expect(await readPreferredPort(stateDir)).toBe(port);
    } finally {
      await daemon.close();
      squatter.stop(true);
    }
  });

  test("an explicit --port bind failure stays fatal (no silent fallback)", async () => {
    const squatter = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("squatter"),
    });
    const daemon = makeDaemon(squatter.port);
    try {
      await expect(daemon.start()).rejects.toThrow();
    } finally {
      squatter.stop(true);
    }
  });
});
