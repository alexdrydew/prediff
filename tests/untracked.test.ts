/**
 * Untracked files in the working range, against an in-process daemon:
 * an agent-created (never `git add`ed) file must show up in the manifest and
 * hunks, bump the revision on refresh, accept comments that survive later
 * refreshes (re-anchoring), and participate in viewed-flag reset semantics.
 * The index must never be touched (no `git add -N`).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DiffManifest, FileDiff, ReviewComment } from "../src/types";
import { Daemon } from "../src/server/server";
import { cleanup, commitAll, initRepo, sh, tempDir, write } from "./helpers";

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

async function refresh(): Promise<{ changed: boolean; revision: number }> {
  return http("/api/refresh", { method: "POST" });
}

beforeAll(async () => {
  repo = await initRepo();
  stateDir = await tempDir("state");
  await write(repo, "src/app.ts", "export {};\n");
  await commitAll(repo, "base");
  // Tracked working change, so the diff is non-empty before any untracked file.
  await write(repo, "src/app.ts", "export const app = 1;\n");

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

test("creating an untracked file bumps the revision and lands in the manifest", async () => {
  const before = await http<DiffManifest>("/api/diff");
  expect(before.revision).toBe(1);
  expect(before.files.map((f) => f.path)).toEqual(["src/app.ts"]);

  await write(repo, "src/agent-new.ts", "export function fresh() {\n  return 42;\n}\n");
  const r = await refresh();
  expect(r.changed).toBe(true);
  expect(r.revision).toBe(2);

  const manifest = await http<DiffManifest>("/api/diff");
  const file = manifest.files.find((f) => f.path === "src/agent-new.ts");
  expect(file).toBeDefined();
  expect(file!.status).toBe("added");
  expect(file!.additions).toBe(3);
  expect(file!.untracked).toBe(true);

  // The index was never touched: the file is still fully untracked.
  const staged = await sh(repo, ["git", "ls-files", "--", "src/agent-new.ts"]);
  expect(staged.trim()).toBe("");
});

test("hunks and full content are served for the untracked file", async () => {
  const diff = await http<FileDiff>(
    "/api/diff/file?path=" + encodeURIComponent("src/agent-new.ts"),
  );
  expect(diff.hunks.length).toBe(1);
  expect(diff.hunks[0]!.lines.every((l) => l.kind === "add")).toBe(true);
  expect(diff.hunks[0]!.lines.map((l) => l.text)).toEqual([
    "export function fresh() {",
    "  return 42;",
    "}",
  ]);

  const content = await http<{ lines: string[] }>(
    "/api/file?path=" + encodeURIComponent("src/agent-new.ts") + "&side=new",
  );
  expect(content.lines.length).toBe(3);
});

test("a comment on an untracked file's lines survives a refresh (re-anchored)", async () => {
  const comment = await http<ReviewComment>("/api/comments", {
    method: "POST",
    body: JSON.stringify({
      file: "src/agent-new.ts",
      side: "new",
      line: 2,
      text: "magic number — name it",
    }),
  });
  expect(comment.state).toBe("draft");
  expect(comment.anchor.lines).toEqual(["  return 42;"]);

  // Prepend a line to the untracked file: the comment must follow.
  await write(
    repo,
    "src/agent-new.ts",
    "// header\nexport function fresh() {\n  return 42;\n}\n",
  );
  const r = await refresh();
  expect(r.changed).toBe(true);
  expect(r.revision).toBe(3);

  const after = await http<ReviewComment>(`/api/comments/${comment.id}`);
  expect(after.state).toBe("draft");
  expect(after.line).toBe(3); // shifted down by the prepended line
  expect(after.revision).toBe(3);
});

test("viewed flag on an untracked file resets when its content changes", async () => {
  await http("/api/viewed", {
    method: "POST",
    body: JSON.stringify({ file: "src/agent-new.ts", viewed: true }),
  });

  // Refresh without changes: flag survives.
  const same = await refresh();
  expect(same.changed).toBe(false);
  const session = await http<{ viewed_files: string[] }>("/api/session");
  expect(session.viewed_files).toContain("src/agent-new.ts");

  await write(
    repo,
    "src/agent-new.ts",
    "// header\nexport function fresh() {\n  return 43;\n}\n",
  );
  const r = await refresh();
  expect(r.changed).toBe(true);

  const after = await http<{ viewed_files: string[] }>("/api/session");
  expect(after.viewed_files).not.toContain("src/agent-new.ts");
});

test("deleting the untracked file removes it from the diff on refresh", async () => {
  await sh(repo, ["rm", "src/agent-new.ts"]);
  const r = await refresh();
  expect(r.changed).toBe(true);

  const manifest = await http<DiffManifest>("/api/diff");
  expect(manifest.files.map((f) => f.path)).toEqual(["src/app.ts"]);

  // The comment isn't dropped — it orphans (spec §6.4).
  const comments = await http<{ comments: ReviewComment[] }>("/api/comments");
  expect(comments.comments[0]!.state).toBe("orphaned");
});
