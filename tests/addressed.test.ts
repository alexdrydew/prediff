/**
 * QA bug §2.1: re-anchoring used to flip submitted → addressed only when the
 * anchored line's own text changed, so a function rewrite that preserved one
 * common line (e.g. `return code;`) slipped through as untouched. The fix
 * compares the comment's FULL anchor window (context_before + lines +
 * context_after) at the matched location — any drift → addressed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReviewComment } from "../src/types";
import { Daemon } from "../src/server/server";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

const SHORTEN = [
  "function shorten(url: string): string {",
  "  const code = makeCode();",
  "  store.set(code, url);",
  "  return code;",
  "}",
  "",
  "export const other = 1;",
].join("\n") + "\n";

/** The function rewritten around the commented line — `return code;` and the
 * line right before it survive verbatim, everything else changed. */
const SHORTEN_REWRITTEN = [
  "function shorten(url: string): string {",
  "  validateUrl(url);",
  "  let code = makeCode();",
  "  while (taken(code)) code = makeCode();",
  "  store.set(code, url);",
  "  return code;",
  "}",
  "",
  "export const other = 1;",
].join("\n") + "\n";

let repo: string;
let stateDir: string;
let daemon: Daemon;
let url: string;

async function http<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(route, url), {
    ...init,
    headers: { "content-type": "application/json" },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? "?"}`);
  return body;
}

async function submitted(file: string, line: number, text: string): Promise<ReviewComment> {
  const c = await http<ReviewComment>("/api/comments", {
    method: "POST",
    body: JSON.stringify({ file, side: "new", line, text }),
  });
  await http(`/api/comments/${c.id}/send`, { method: "POST", body: "{}" });
  return c;
}

beforeAll(async () => {
  repo = await initRepo();
  stateDir = await tempDir("state");
  await write(repo, "src/shorten.ts", "export {};\n");
  await write(repo, "src/config.ts", "export const LIMIT = 1;\n");
  await commitAll(repo, "base");
  await write(repo, "src/shorten.ts", SHORTEN);
  await write(repo, "src/config.ts", "export const LIMIT = 2;\n");

  daemon = new Daemon({ repoRoot: repo, stateDir, range: "working", ttlMs: 0 });
  await daemon.start();
  url = daemon.url;
  (daemon as unknown as { watcher: { stop(): void } }).watcher.stop();
});

afterAll(async () => {
  await daemon.close();
  await cleanup(repo, stateDir);
});

describe("addressed detection uses the full anchor window (QA §2.1)", () => {
  let onReturn: ReviewComment;
  let onConfig: ReviewComment;

  test("QA repro: function rewritten around a preserved `return code;` → addressed", async () => {
    onReturn = await submitted("src/shorten.ts", 4, "returning before persisting?");
    onConfig = await submitted("src/config.ts", 1, "limit bump intended?");
    expect(onReturn.anchor.lines).toEqual(["  return code;"]);

    await write(repo, "src/shorten.ts", SHORTEN_REWRITTEN);
    await http("/api/refresh", { method: "POST", body: "{}" });

    const after = await http<ReviewComment>(`/api/comments/${onReturn.id}`);
    expect(after.state).toBe("addressed"); // was: stayed "submitted"
    expect(after.line).toBe(6); // still re-anchored onto the surviving line
    expect(after.anchor.lines).toEqual(["  return code;"]);
  });

  test("untouched file: comment state unchanged by the same refresh", async () => {
    const config = await http<ReviewComment>(`/api/comments/${onConfig.id}`);
    expect(config.state).toBe("submitted");
  });

  test("pure shift (exact full-window match) still follows silently", async () => {
    const cur = await Bun.file(`${repo}/src/shorten.ts`).text();
    await write(repo, "src/shorten.ts", "// banner\n// banner 2\n" + cur);
    await http("/api/refresh", { method: "POST", body: "{}" });

    const after = await http<ReviewComment>(`/api/comments/${onReturn.id}`);
    expect(after.state).toBe("addressed"); // no NEW drift: not re-flagged, not reset
    expect(after.line).toBe(8);

    // A submitted comment whose window merely shifted stays submitted.
    const fresh = await submitted("src/shorten.ts", 8, "double-check retry bound");
    await write(repo, "src/shorten.ts", "// third banner\n" + (await Bun.file(`${repo}/src/shorten.ts`).text()));
    await http("/api/refresh", { method: "POST", body: "{}" });
    const shifted = await http<ReviewComment>(`/api/comments/${fresh.id}`);
    expect(shifted.state).toBe("submitted");
    expect(shifted.line).toBe(9);
  });
});
