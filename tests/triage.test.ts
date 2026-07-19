/**
 * Orphaned-comment triage (spec §6.4 / wireframe 5) and the small API
 * additions the UI needs: POST /api/comments/:id/reanchor, GET /api/file
 * (expand context), and per-revision summaries on /api/revisions.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReviewComment, RevisionsResult, FileContentResult } from "../src/types";
import { Daemon } from "../src/server/server";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

const APP = [
  "function alpha() {",
  "  return 1;",
  "}",
  "",
  "function beta() {",
  "  return 2;",
  "}",
  "",
  "function gamma() {",
  "  return 3;",
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

async function orphanedComment(text: string, line: number): Promise<ReviewComment> {
  const c = await http<ReviewComment>("/api/comments", {
    method: "POST",
    body: JSON.stringify({ file: "src/app.ts", side: "new", line, text }),
  });
  await http(`/api/comments/${c.id}/send`, { method: "POST", body: "{}" });
  return c;
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

describe("orphaned-comment triage", () => {
  let orphanA: ReviewComment;
  let orphanB: ReviewComment;
  let orphanC: ReviewComment;
  let healthy: ReviewComment;

  test("setup: deleting a region orphans the comments on it", async () => {
    // Three comments on beta() (lines 5–7), one on gamma() (line 10 — far
    // enough that its full anchor window is outside the deleted region;
    // anything closer is honestly "addressed" under the §2.1 window check).
    orphanA = await orphanedComment("beta A", 5);
    orphanB = await orphanedComment("beta B", 6);
    orphanC = await orphanedComment("beta C", 7);
    healthy = await orphanedComment("gamma stays", 10);

    const gutted = APP.split("\n")
      .filter((l) => !/beta|return 2/.test(l))
      .join("\n");
    await write(repo, "src/app.ts", gutted);
    await http("/api/refresh", { method: "POST", body: "{}" });

    for (const id of [orphanA.id, orphanB.id, orphanC.id]) {
      expect((await http<ReviewComment>(`/api/comments/${id}`)).state).toBe("orphaned");
    }
    expect((await http<ReviewComment>(`/api/comments/${healthy.id}`)).state).toBe("submitted");
  });

  test("manual re-anchor moves the comment and returns it to submitted", async () => {
    const re = await http<ReviewComment>(`/api/comments/${orphanA.id}/reanchor`, {
      method: "POST",
      body: JSON.stringify({ line: 5, end_line: 6, side: "new" }),
    });
    expect(re.state).toBe("submitted");
    expect(re.line).toBe(5);
    expect(re.end_line).toBe(6);
    expect(re.anchor.lines.length).toBe(2);

    // The refreshed anchor tracks future revisions again.
    const cur = await Bun.file(`${repo}/src/app.ts`).text();
    await write(repo, "src/app.ts", "// prelude\n" + cur);
    await http("/api/refresh", { method: "POST", body: "{}" });
    const after = await http<ReviewComment>(`/api/comments/${orphanA.id}`);
    expect(after.state).toBe("submitted");
    expect(after.line).toBe(6);
  });

  test("convert to file note: line 0, empty anchor, survives revisions", async () => {
    const note = await http<ReviewComment>(`/api/comments/${orphanB.id}/reanchor`, {
      method: "POST",
      body: JSON.stringify({ file_note: true }),
    });
    expect(note.state).toBe("submitted");
    expect(note.line).toBe(0);
    expect(note.end_line).toBe(0);
    expect(note.anchor.lines).toEqual([]);

    const cur = await Bun.file(`${repo}/src/app.ts`).text();
    await write(repo, "src/app.ts", cur + "// trailer\n");
    await http("/api/refresh", { method: "POST", body: "{}" });
    const after = await http<ReviewComment>(`/api/comments/${orphanB.id}`);
    expect(after.state).toBe("submitted");
    expect(after.line).toBe(0);
  });

  test("dismiss is a plain PATCH to resolved", async () => {
    const dismissed = await http<ReviewComment>(`/api/comments/${orphanC.id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "resolved" }),
    });
    expect(dismissed.state).toBe("resolved");
  });

  test("reanchor is rejected for non-orphaned comments and bad input", async () => {
    expect(
      await httpStatus(`/api/comments/${healthy.id}/reanchor`, {
        method: "POST",
        body: JSON.stringify({ line: 1 }),
      }),
    ).toBe(400);
    expect(
      await httpStatus(`/api/comments/nope/reanchor`, {
        method: "POST",
        body: JSON.stringify({ line: 1 }),
      }),
    ).toBe(404);
  });
});

describe("expand-context file content", () => {
  test("GET /api/file returns the new side of a changed file", async () => {
    const res = await http<FileContentResult>("/api/file?path=src/app.ts&side=new");
    expect(res.side).toBe("new");
    expect(res.lines.length).toBeGreaterThan(3);
    expect(res.lines.join("\n")).toContain("alpha");
  });

  test("GET /api/file old side serves the base content", async () => {
    const res = await http<FileContentResult>("/api/file?path=src/app.ts&side=old");
    expect(res.lines).toEqual(["export {};"]);
  });

  test("files outside the diff are 404", async () => {
    expect(await httpStatus("/api/file?path=nope.ts")).toBe(404);
    expect(await httpStatus("/api/file")).toBe(400);
  });
});

describe("revision summaries", () => {
  test("/api/revisions lists per-revision stats and timestamps", async () => {
    const revs = await http<RevisionsResult>("/api/revisions");
    expect(revs.revisions.length).toBe(revs.available.length);
    expect(revs.revisions.map((r) => r.revision)).toEqual(revs.available);
    for (const r of revs.revisions) {
      expect(typeof r.created_at).toBe("string");
      expect(r.files).toBeGreaterThan(0);
      expect(r.additions + r.deletions).toBeGreaterThan(0);
    }
    expect(revs.revisions.at(-1)?.revision).toBe(revs.current);
  });
});
