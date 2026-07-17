/**
 * End-to-end: temp git repo → `prediff open` (real CLI, detached daemon) →
 * comment via HTTP → read via CLI → re-anchor across a refresh → submit →
 * `wait` returns with the right exit code → `stop`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import type { OpenResult, ReviewComment, Session, StatusResult, WaitResult } from "../src/types";
import { BUN, cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

const CLI = path.join(import.meta.dir, "..", "src", "cli", "index.ts");

let repo: string;
let stateHome: string;
let env: Record<string, string>;
let opened: OpenResult;

async function cli(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BUN, CLI, ...args], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function cliJson<T>(r: { stdout: string }): T {
  return JSON.parse(r.stdout) as T;
}

async function http<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(route, opened.url), {
    ...init,
    headers: { "content-type": "application/json" },
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as T;
}

beforeAll(async () => {
  repo = await initRepo();
  stateHome = await tempDir("state");
  env = {
    ...process.env,
    PREDIFF_STATE_DIR: stateHome,
    PREDIFF_NO_BROWSER: "1",
  } as Record<string, string>;

  await write(repo, "src/app.ts", "export function add(a: number, b: number) {\n  return a - b;\n}\n");
  await write(repo, "README.md", "# demo\n");
  await commitAll(repo, "base");
  // Working-tree change to review.
  await write(
    repo,
    "src/app.ts",
    "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport const VERSION = 1;\n",
  );
});

afterAll(async () => {
  await cli(["stop", "--json"], { timeoutMs: 10_000 }).catch(() => {});
  await cleanup(repo, stateHome);
});

test("open spawns a detached daemon and prints session info", async () => {
  const r = await cli(["open", "working", "--json"]);
  expect(r.code).toBe(0);
  opened = cliJson<OpenResult>(r);
  expect(opened.session_id).toMatch(/^sess_/);
  expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(opened.files).toBe(1);
  expect(opened.additions).toBe(3);
  expect(opened.deletions).toBe(1);
}, 20_000);

test("open reuses the live daemon", async () => {
  const r = await cli(["open", "working", "--json"]);
  const again = cliJson<OpenResult>(r);
  expect(again.url).toBe(opened.url);
  expect(again.session_id).toBe(opened.session_id);
}, 20_000);

test("manifest and file hunks over HTTP", async () => {
  const manifest = await http<{ files: { path: string }[]; generation: number }>("/api/diff");
  expect(manifest.files.map((f) => f.path)).toEqual(["src/app.ts"]);
  const file = await http<{ hunks: { lines: unknown[] }[] }>(
    "/api/diff/file?path=" + encodeURIComponent("src/app.ts"),
  );
  expect(file.hunks.length).toBeGreaterThan(0);
});

test("UI is served", async () => {
  const res = await fetch(opened.url);
  expect(res.ok).toBe(true);
  expect(await res.text()).toContain("prediff");
});

test("post a comment via HTTP, read it via CLI", async () => {
  const comment = await http<ReviewComment>("/api/comments", {
    method: "POST",
    body: JSON.stringify({ file: "src/app.ts", line: 2, side: "new", text: "nice fix" }),
  });
  expect(comment.state).toBe("open");
  expect(comment.anchor.lines).toEqual(["  return a + b;"]);

  const r = await cli(["comments", "--json"]);
  expect(r.code).toBe(0);
  const { comments } = cliJson<{ comments: ReviewComment[] }>(r);
  expect(comments.length).toBe(1);
  expect(comments[0]!.text).toBe("nice fix");

  // Durability: comment is on disk immediately.
  const glob = new Bun.Glob("*/sessions/*.json");
  const files = await Array.fromAsync(glob.scan({ cwd: stateHome, absolute: true }));
  expect(files.length).toBe(1);
  const onDisk = (await Bun.file(files[0]!).json()) as Session;
  expect(onDisk.comments[0]!.text).toBe("nice fix");
});

test("wait returns 2 on new comments", async () => {
  const waiting = cli(["wait", "--timeout", "15", "--json"]);
  await Bun.sleep(300); // let the long-poll register
  await http("/api/comments", {
    method: "POST",
    body: JSON.stringify({ file: "src/app.ts", line: 5, side: "new", text: "bump version?" }),
  });
  const r = await waiting;
  expect(r.code).toBe(2);
  const result = cliJson<WaitResult>(r);
  expect(result.reason).toBe("new-comments");
  expect(result.new_comments.length).toBe(1);
  expect(result.new_comments[0]!.text).toBe("bump version?");
}, 20_000);

test("wait times out with exit code 3", async () => {
  const r = await cli(["wait", "--timeout", "1", "--json"]);
  expect(r.code).toBe(3);
  expect(cliJson<WaitResult>(r).reason).toBe("timeout");
}, 20_000);

test("agent edits file → refresh bumps generation and re-anchors", async () => {
  // Insert lines above the commented line; the comment should follow it.
  await write(
    repo,
    "src/app.ts",
    "// prediff e2e\n// header comment\nexport function add(a: number, b: number) {\n  return a + b;\n}\n\nexport const VERSION = 1;\n",
  );
  const r = await cli(["refresh", "--json"]);
  expect(r.code).toBe(0);
  const refresh = cliJson<{ changed: boolean; generation: number }>(r);
  expect(refresh.changed).toBe(true);
  expect(refresh.generation).toBe(2);

  const { comments } = cliJson<{ comments: ReviewComment[] }>(await cli(["comments", "--json"]));
  const first = comments.find((c) => c.text === "nice fix")!;
  expect(first.line).toBe(4); // was 2, shifted by two header lines
  expect(first.state).toBe("open");
  expect(first.generation).toBe(2);
}, 20_000);

test("resolve with reply via CLI", async () => {
  const { comments } = cliJson<{ comments: ReviewComment[] }>(await cli(["comments", "--json"]));
  const target = comments.find((c) => c.text === "bump version?")!;
  const r = await cli(["resolve", target.id, "--reply", "done in latest edit", "--json"]);
  expect(r.code).toBe(0);
  const resolved = cliJson<ReviewComment>(r);
  expect(resolved.state).toBe("resolved");
  expect(resolved.replies[0]).toMatchObject({ from: "agent", text: "done in latest edit" });

  const unresolved = cliJson<{ comments: ReviewComment[] }>(
    await cli(["comments", "--json", "--unresolved"]),
  );
  expect(unresolved.comments.map((c) => c.text)).toEqual(["nice fix"]);
});

test("submit review → wait returns 0 with reason submitted", async () => {
  const waiting = cli(["wait", "--timeout", "15", "--json"]);
  await Bun.sleep(300);
  await http("/api/review/submit", { method: "POST" });
  const r = await waiting;
  expect(r.code).toBe(0);
  expect(cliJson<WaitResult>(r).reason).toBe("submitted");

  const status = cliJson<StatusResult>(await cli(["status", "--json"]));
  expect(status.review_state).toBe("submitted");
}, 20_000);

test("comment on a fully rewritten region becomes outdated, never dropped", async () => {
  await write(repo, "src/app.ts", "export const totally = 'different';\n");
  await cli(["refresh", "--json"]);
  const { comments } = cliJson<{ comments: ReviewComment[] }>(await cli(["comments", "--json"]));
  const first = comments.find((c) => c.text === "nice fix")!;
  expect(first.state).toBe("outdated");
  expect(comments.length).toBe(2);
}, 20_000);

test("stop shuts the daemon down and clears the lockfile", async () => {
  const r = await cli(["stop", "--json"]);
  expect(r.code).toBe(0);
  const status = await cli(["status", "--json"]);
  expect(status.code).not.toBe(0); // no daemon anymore
  const locks = await Array.fromAsync(
    new Bun.Glob("*/daemon.json").scan({ cwd: stateHome, absolute: true }),
  );
  expect(locks).toEqual([]);
}, 20_000);
