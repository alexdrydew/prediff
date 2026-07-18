/**
 * Review-model semantics against an in-process daemon (no CLI spawn):
 * comment lifecycle (draft → submitted batches, send-now, addressed-on-modify,
 * orphaned-on-delete, resolved stability), revision history retrieval,
 * viewed-file reset semantics, wait wake-ups, and v1 → v2 session migration.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  FeedbackBatch,
  ReviewComment,
  Session,
  WaitResult,
} from "../src/types";
import { Daemon } from "../src/server/server";
import { RevisionStore, HISTORY_MAX } from "../src/store/revisions";
import { SessionStore } from "../src/store/session";
import { writeJsonAtomic } from "../src/store/atomic";
import { sessionPath, currentSessionPath } from "../src/store/paths";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

const APP = [
  "export function greet(name: string) {",
  '  return "hello " + name;',
  "}",
  "",
  "export function farewell(name: string) {",
  '  return "bye " + name;',
  "}",
  "",
  "export const LANG = 'en';",
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

async function httpStatus(route: string, init?: RequestInit): Promise<number> {
  const res = await fetch(new URL(route, url), {
    ...init,
    headers: { "content-type": "application/json" },
  });
  await res.text();
  return res.status;
}

async function draft(input: {
  file?: string;
  line: number;
  end_line?: number;
  text: string;
  tag?: string;
}): Promise<ReviewComment> {
  return http<ReviewComment>("/api/comments", {
    method: "POST",
    body: JSON.stringify({ file: "src/app.ts", side: "new", ...input }),
  });
}

async function refresh(): Promise<{ revision: number }> {
  return http<{ revision: number }>("/api/refresh", { method: "POST" });
}

async function comment(id: string): Promise<ReviewComment> {
  return http<ReviewComment>(`/api/comments/${id}`);
}

beforeAll(async () => {
  repo = await initRepo();
  stateDir = await tempDir("state");
  await write(repo, "src/app.ts", "export {};\n");
  await write(repo, "src/other.ts", "export const other = 1;\n");
  await commitAll(repo, "base");
  await write(repo, "src/app.ts", APP);
  await write(repo, "src/other.ts", "export const other = 2;\n");

  daemon = new Daemon({ repoRoot: repo, stateDir, range: "working", ttlMs: 0 });
  await daemon.start();
  url = daemon.url;
  // Deterministic revisions: only explicit /api/refresh bumps in these tests.
  (daemon as unknown as { watcher: { stop(): void } }).watcher.stop();
});

afterAll(async () => {
  await daemon.close();
  await cleanup(repo, stateDir);
});

describe("comment lifecycle", () => {
  test("drafts autosave via PATCH; draft → submitted must use the send endpoints", async () => {
    const c = await draft({ line: 2, text: "typo?" });
    expect(c.state).toBe("draft");
    expect(c.batch_id).toBeNull();

    const patched = await http<ReviewComment>(`/api/comments/${c.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "typo? (edited)", tag: "nit" }),
    });
    expect(patched.text).toBe("typo? (edited)");
    expect(patched.tag).toBe("nit");
    expect(patched.state).toBe("draft");

    // Backdoor submission via PATCH is rejected.
    expect(
      await httpStatus(`/api/comments/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "submitted" }),
      }),
    ).toBe(400);

    // Drafts cannot be resolved.
    expect(await httpStatus(`/api/comments/${c.id}/resolve`, { method: "POST" })).toBe(400);

    await http(`/api/comments/${c.id}`, { method: "DELETE" });
  });

  test("send feedback flips all drafts to submitted as one batch and wakes wait", async () => {
    const a = await draft({ line: 2, text: "greet: use template literal" });
    const b = await draft({ line: 6, text: "farewell too", tag: "suggestion" });

    const waiting = fetch(new URL("/api/wait?timeout=10", url));
    await Bun.sleep(200);

    const sent = await http<{ batch: FeedbackBatch; comments: ReviewComment[] }>(
      "/api/feedback/send",
      { method: "POST" },
    );
    expect(sent.batch.comment_ids.sort()).toEqual([a.id, b.id].sort());
    expect(sent.comments.every((c) => c.state === "submitted")).toBe(true);
    expect(sent.comments.every((c) => c.batch_id === sent.batch.id)).toBe(true);
    expect(sent.comments.every((c) => typeof c.submitted_at === "string")).toBe(true);

    const woke = (await (await waiting).json()) as WaitResult;
    expect(woke.reason).toBe("feedback");
    expect(woke.batch_id).toBe(sent.batch.id);
    expect(woke.comments.length).toBe(2);

    // No drafts left → sending again is a client error.
    expect(await httpStatus("/api/feedback/send", { method: "POST" })).toBe(400);
  });

  test("send-now submits a single draft as its own batch and wakes wait", async () => {
    const c = await draft({ line: 9, text: "LANG should be configurable" });
    const waiting = fetch(new URL("/api/wait?timeout=10", url));
    await Bun.sleep(200);

    const sent = await http<ReviewComment>(`/api/comments/${c.id}/send`, { method: "POST" });
    expect(sent.state).toBe("submitted");
    expect(sent.batch_id).not.toBeNull();

    const woke = (await (await waiting).json()) as WaitResult;
    expect(woke.reason).toBe("feedback");
    expect(woke.comments.map((x) => x.id)).toEqual([c.id]);

    // Sending a non-draft again is rejected.
    expect(await httpStatus(`/api/comments/${c.id}/send`, { method: "POST" })).toBe(400);
  });

  test("modifying the anchored region marks submitted comments addressed", async () => {
    const before = await http<{ comments: ReviewComment[] }>("/api/comments");
    const greet = before.comments.find((c) => c.text === "greet: use template literal")!;
    expect(greet.state).toBe("submitted");

    // Agent rewrites exactly the commented line (context intact).
    await write(repo, "src/app.ts", APP.replace('  return "hello " + name;', "  return `hello ${name}`;"));
    await refresh();

    const after = await comment(greet.id);
    expect(after.state).toBe("addressed");
    expect(after.line).toBe(2); // re-anchored onto the modified region
  });

  test("an unchanged/shifted comment follows silently, state unchanged", async () => {
    const langBefore = await http<{ comments: ReviewComment[] }>("/api/comments");
    const lang = langBefore.comments.find((c) => c.text === "LANG should be configurable")!;
    expect(lang.state).toBe("submitted");
    expect(lang.line).toBe(9);

    // Insert lines above everything: pure shift.
    const current = APP.replace('  return "hello " + name;', "  return `hello ${name}`;");
    await write(repo, "src/app.ts", "// banner\n// banner 2\n" + current);
    await refresh();

    const after = await comment(lang.id);
    expect(after.state).toBe("submitted"); // silent follow
    expect(after.line).toBe(11);
  });

  test("resolved comments are stable across modifications of their region", async () => {
    const all = await http<{ comments: ReviewComment[] }>("/api/comments");
    const farewell = all.comments.find((c) => c.text === "farewell too")!;
    await http(`/api/comments/${farewell.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ reply: "done" }),
    });

    // Rewrite the farewell line — a resolved comment must not resurface.
    const cur = (await Bun.file(`${repo}/src/app.ts`).text()).replace(
      '  return "bye " + name;',
      "  return `bye ${name}`;",
    );
    await write(repo, "src/app.ts", cur);
    await refresh();

    const after = await comment(farewell.id);
    expect(after.state).toBe("resolved");
  });

  test("deleting the anchored region (and context) orphans the comment", async () => {
    const all = await http<{ comments: ReviewComment[] }>("/api/comments");
    const lang = all.comments.find((c) => c.text === "LANG should be configurable")!;

    // Remove the LANG line and everything around it.
    const cur = await Bun.file(`${repo}/src/app.ts`).text();
    const gutted = cur
      .split("\n")
      .filter((l) => !l.includes("LANG") && !l.includes("farewell") && !l.includes("bye"))
      .join("\n");
    await write(repo, "src/app.ts", gutted);
    await refresh();

    const after = await comment(lang.id);
    expect(after.state).toBe("orphaned");

    // Orphaned comments are excluded by --unresolved? No — still unresolved.
    const unresolved = await http<{ comments: ReviewComment[] }>(
      "/api/comments?unresolved=1&exclude_drafts=1",
    );
    expect(unresolved.comments.some((c) => c.id === lang.id)).toBe(true);
  });

  test("state filter works over the API", async () => {
    const addressed = await http<{ comments: ReviewComment[] }>("/api/comments?state=addressed");
    expect(addressed.comments.length).toBeGreaterThan(0);
    expect(addressed.comments.every((c) => c.state === "addressed")).toBe(true);

    const multi = await http<{ comments: ReviewComment[] }>(
      "/api/comments?state=addressed,orphaned",
    );
    expect(multi.comments.length).toBeGreaterThan(addressed.comments.length - 1);
  });
});

describe("session actions", () => {
  test("mark-ready is allowed with open comments and reports counts", async () => {
    const waiting = fetch(new URL("/api/wait?timeout=10", url));
    await Bun.sleep(200);

    const ready = await http<{
      session_state: string;
      ready_at: string;
      comments: { total: number; orphaned: number };
    }>("/api/session/mark-ready", { method: "POST" });
    expect(ready.session_state).toBe("ready");
    expect(ready.comments.orphaned).toBeGreaterThan(0);

    const woke = (await (await waiting).json()) as WaitResult;
    expect(woke.reason).toBe("ready");
    expect(woke.comments).toEqual([]);

    // A wait started while ready returns immediately.
    const immediate = (await (await fetch(new URL("/api/wait?timeout=30", url))).json()) as WaitResult;
    expect(immediate.reason).toBe("ready");
  });

  test("sending feedback after mark-ready re-opens the session", async () => {
    await draft({ line: 1, text: "one more thing" });
    await http("/api/feedback/send", { method: "POST" });
    const session = await http<Session>("/api/session");
    expect(session.session_state).toBe("reviewing");
    expect(session.ready_at).toBeUndefined();
  });
});

describe("viewed files", () => {
  test("set via API, reset only for files whose diff content changed", async () => {
    const viewed = await http<{ viewed_files: string[] }>("/api/viewed", {
      method: "POST",
      body: JSON.stringify({ files: ["src/app.ts", "src/other.ts"], viewed: true }),
    });
    expect(viewed.viewed_files.sort()).toEqual(["src/app.ts", "src/other.ts"]);

    // Change only src/app.ts; src/other.ts's diff is untouched.
    const cur = await Bun.file(`${repo}/src/app.ts`).text();
    await write(repo, "src/app.ts", cur + "export const tail = 1;\n");
    await refresh();

    const session = await http<Session>("/api/session");
    expect(session.viewed_files).toEqual(["src/other.ts"]);
  });

  test("unview works and invalid payloads are rejected", async () => {
    const after = await http<{ viewed_files: string[] }>("/api/viewed", {
      method: "POST",
      body: JSON.stringify({ file: "src/other.ts", viewed: false }),
    });
    expect(after.viewed_files).toEqual([]);
    expect(await httpStatus("/api/viewed", { method: "POST", body: "{}" })).toBe(400);
  });
});

describe("revision history", () => {
  test("every revision is retrievable with manifest and per-file hunks", async () => {
    const revs = await http<{ current: number; available: number[] }>("/api/revisions");
    expect(revs.available.length).toBeGreaterThanOrEqual(2);
    expect(revs.available.at(-1)).toBe(revs.current);

    const first = await http<{ revision: number; files: { path: string }[] }>(
      "/api/diff?revision=1",
    );
    expect(first.revision).toBe(1);
    expect(first.files.map((f) => f.path)).toContain("src/app.ts");

    const oldFile = await http<{ hunks: { lines: { text: string }[] }[] }>(
      "/api/diff/file?path=" + encodeURIComponent("src/app.ts") + "&revision=1",
    );
    const texts = oldFile.hunks.flatMap((h) => h.lines.map((l) => l.text));
    expect(texts).toContain('  return "hello " + name;'); // pre-rewrite content
    expect(texts).not.toContain("  return `hello ${name}`;");
  });

  test("unknown and invalid revisions are 404/400", async () => {
    expect(await httpStatus("/api/diff?revision=999")).toBe(404);
    expect(await httpStatus("/api/diff?revision=zero")).toBe(400);
    expect(
      await httpStatus("/api/diff/file?path=src%2Fapp.ts&revision=999"),
    ).toBe(404);
  });

  test("history is bounded to the last HISTORY_MAX revisions", async () => {
    const store = new RevisionStore(await tempDir("revstore"));
    const manifest = { range: "working", revision: 0, files: [], additions: 0, deletions: 0 };
    for (let n = 1; n <= HISTORY_MAX + 5; n++) {
      await store.save("sess_test", {
        revision: n,
        created_at: new Date().toISOString(),
        manifest: { ...manifest, revision: n },
        raw_diff: `diff ${n}`,
      });
    }
    const kept = await store.list("sess_test");
    expect(kept.length).toBe(HISTORY_MAX);
    expect(kept[0]).toBe(6);
    expect(await store.load("sess_test", 5)).toBeNull();
    expect((await store.load("sess_test", HISTORY_MAX + 5))?.raw_diff).toBe(
      `diff ${HISTORY_MAX + 5}`,
    );
    await cleanup(store.stateDir);
  });
});

describe("v1 → v2 session migration", () => {
  test("old sessions load with mapped states instead of being discarded", async () => {
    const dir = await tempDir("migrate");
    const v1 = {
      session_id: "sess_v1legacy",
      repo_root: "/some/repo",
      range: "working",
      generation: 4,
      review_state: "submitted",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      submitted_at: "2026-01-02T00:00:00.000Z",
      comments: [
        {
          id: "c_open",
          file: "a.ts",
          line: 1,
          end_line: 1,
          side: "new",
          text: "still relevant",
          state: "open",
          generation: 3,
          anchor: { context_before: [], lines: ["x"], context_after: [] },
          replies: [],
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "c_outdated",
          file: "a.ts",
          line: 2,
          end_line: 2,
          side: "new",
          text: "code moved on",
          state: "outdated",
          generation: 2,
          anchor: { context_before: [], lines: ["y"], context_after: [] },
          replies: [],
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await writeJsonAtomic(sessionPath(dir, v1.session_id), v1);
    await writeJsonAtomic(currentSessionPath(dir), { session_id: v1.session_id });

    const migrated = await new SessionStore(dir).loadCurrent();
    expect(migrated).not.toBeNull();
    expect(migrated!.schema_version).toBe(2);
    expect(migrated!.revision).toBe(4);
    expect(migrated!.session_state).toBe("ready");
    expect(migrated!.ready_at).toBe("2026-01-02T00:00:00.000Z");
    expect(migrated!.scope).toBeNull();
    expect(migrated!.viewed_files).toEqual([]);
    expect(migrated!.feedback_batches).toEqual([]);
    const byId = new Map(migrated!.comments.map((c) => [c.id, c]));
    expect(byId.get("c_open")!.state).toBe("submitted");
    expect(byId.get("c_open")!.revision).toBe(3);
    expect(byId.get("c_open")!.tag).toBeNull();
    expect(byId.get("c_outdated")!.state).toBe("orphaned");
    await cleanup(dir);
  });
});
