/**
 * Review-level (non-line) comments — QA gap §1.1. A comment with no file is
 * the GitHub "review summary" equivalent: same draft → submitted → resolved
 * lifecycle as every other comment, but re-anchoring never touches it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReviewComment, StatusResult, WaitResult } from "../src/types";
import { Daemon } from "../src/server/server";
import { migrateSession } from "../src/store/session";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

const APP = [
  "export function greet(name: string) {",
  '  return "hello " + name;',
  "}",
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

beforeAll(async () => {
  repo = await initRepo();
  stateDir = await tempDir("state");
  await write(repo, "src/app.ts", "export {};\n");
  await commitAll(repo, "base");
  await write(repo, "src/app.ts", APP);

  daemon = new Daemon({ repoRoot: repo, stateDir, range: "working", ttlMs: 0 });
  await daemon.start();
  url = daemon.url;
  (daemon as unknown as { watcher: { stop(): void } }).watcher.stop();
});

afterAll(async () => {
  await daemon.close();
  await cleanup(repo, stateDir);
});

describe("review-level comments (QA §1.1)", () => {
  let review: ReviewComment;
  let lineComment: ReviewComment;

  test("POST /api/comments with no file creates a review-level draft", async () => {
    review = await http<ReviewComment>("/api/comments", {
      method: "POST",
      body: JSON.stringify({ text: "overall: collision retry and validation belong together" }),
    });
    expect(review.kind).toBe("review");
    expect(review.file).toBeNull();
    expect(review.line).toBe(0);
    expect(review.end_line).toBe(0);
    expect(review.state).toBe("draft");
    expect(review.anchor.lines).toEqual([]);

    // Explicit file: null works too.
    const second = await http<ReviewComment>("/api/comments", {
      method: "POST",
      body: JSON.stringify({ file: null, text: "temp", tag: "question" }),
    });
    expect(second.kind).toBe("review");
    expect(second.tag).toBe("question");
    await http(`/api/comments/${second.id}`, { method: "DELETE" });
  });

  test("review-level comments reject a nonzero line; bad file types are 400", async () => {
    expect(
      await httpStatus("/api/comments", {
        method: "POST",
        body: JSON.stringify({ text: "x", line: 3 }),
      }),
    ).toBe(400);
    expect(
      await httpStatus("/api/comments", {
        method: "POST",
        body: JSON.stringify({ file: 42, text: "x" }),
      }),
    ).toBe(400);
    expect(await httpStatus("/api/comments", { method: "POST", body: "{}" })).toBe(400);
  });

  test("file + line 0 creates a file note", async () => {
    const note = await http<ReviewComment>("/api/comments", {
      method: "POST",
      body: JSON.stringify({ file: "src/app.ts", line: 0, text: "whole-file note" }),
    });
    expect(note.kind).toBe("file-note");
    expect(note.file).toBe("src/app.ts");
    expect(note.line).toBe(0);
    expect(note.anchor.lines).toEqual([]);
    await http(`/api/comments/${note.id}`, { method: "DELETE" });
  });

  test("same lifecycle: batch send wakes wait with the review comment", async () => {
    lineComment = await http<ReviewComment>("/api/comments", {
      method: "POST",
      body: JSON.stringify({ file: "src/app.ts", line: 2, text: "use a template literal" }),
    });
    expect(lineComment.kind).toBe("line");

    const waiting = fetch(new URL("/api/wait?timeout=10", url));
    await Bun.sleep(200);
    await http("/api/feedback/send", { method: "POST" });

    const woke = (await (await waiting).json()) as WaitResult;
    expect(woke.reason).toBe("feedback");
    expect(woke.comments.map((c) => c.id).sort()).toEqual([review.id, lineComment.id].sort());
    expect((await http<ReviewComment>(`/api/comments/${review.id}`)).state).toBe("submitted");
  });

  test("re-anchoring skips review-level comments entirely", async () => {
    // Rewrite the whole file: the line comment orphans, the review comment
    // must stay submitted (never addressed/orphaned automatically).
    await write(repo, "src/app.ts", "export const rewritten = true;\n");
    await http("/api/refresh", { method: "POST", body: "{}" });

    const reviewAfter = await http<ReviewComment>(`/api/comments/${review.id}`);
    expect(reviewAfter.state).toBe("submitted");
    expect(reviewAfter.kind).toBe("review");
    expect(reviewAfter.line).toBe(0);
    expect((await http<ReviewComment>(`/api/comments/${lineComment.id}`)).state).toBe("orphaned");
  });

  test("review-level comments cannot be re-anchored (no anchor)", async () => {
    expect(
      await httpStatus(`/api/comments/${review.id}/reanchor`, {
        method: "POST",
        body: JSON.stringify({ line: 1 }),
      }),
    ).toBe(400);
  });

  test("GET /api/comments sorts review-level comments first", async () => {
    const { comments } = await http<{ comments: ReviewComment[] }>(
      "/api/comments?exclude_drafts=1",
    );
    expect(comments.length).toBeGreaterThanOrEqual(2);
    expect(comments[0]!.kind).toBe("review");
    expect(comments[0]!.id).toBe(review.id);
  });

  test("/api/status counts include the per-kind breakdown", async () => {
    const status = await http<StatusResult>("/api/status");
    expect(status.comments.kinds.review).toBe(1);
    expect(status.comments.kinds.line).toBe(1);
    expect(status.comments.kinds["file-note"]).toBe(0);
    expect(status.comments.total).toBe(2);
  });

  test("agent reply + resolve work on a review-level comment", async () => {
    const resolved = await http<ReviewComment>(`/api/comments/${review.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ reply: "restructured as requested" }),
    });
    expect(resolved.state).toBe("resolved");
    expect(resolved.replies[0]).toMatchObject({ from: "agent", text: "restructured as requested" });
  });
});

describe("kind normalization for pre-kind sessions", () => {
  test("comments without kind load as line / file-note", () => {
    const base = {
      id: "c_x",
      line: 3,
      end_line: 3,
      side: "new",
      text: "t",
      state: "submitted",
      tag: null,
      revision: 1,
      anchor: { context_before: [], lines: ["x"], context_after: [] },
      replies: [],
      batch_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const session = migrateSession({
      schema_version: 2,
      session_id: "sess_x",
      repo_root: "/r",
      range: "working",
      revision: 1,
      session_state: "reviewing",
      scope: null,
      viewed_files: [],
      feedback_batches: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      comments: [
        { ...base, id: "c_line", file: "a.ts" },
        { ...base, id: "c_note", file: "a.ts", line: 0, end_line: 0 },
      ],
    });
    const byId = new Map(session.comments.map((c) => [c.id, c]));
    expect(byId.get("c_line")!.kind).toBe("line");
    expect(byId.get("c_note")!.kind).toBe("file-note");
  });
});
