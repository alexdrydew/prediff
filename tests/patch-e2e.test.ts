import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import type { OpenResult, ReviewComment, Session, StatusResult } from "../src/types";
import { BUN, cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

const CLI = path.join(import.meta.dir, "..", "src", "cli", "index.ts");

let workspace: string;
let otherDir: string;
let gitWorkspace: string;
let stateHome: string;
let env: Record<string, string>;
let opened: OpenResult;

const PATCH_V1 = [
  "--- before/app.ts\t2026-07-25 10:00:00",
  "+++ after/app.ts\t2026-07-25 10:01:00",
  "@@ -1,3 +1,3 @@",
  " export function value() {",
  "-  return 1;",
  "+  return 2;",
  " }",
  "",
].join("\n");

const PATCH_V2 = PATCH_V1.replace("return 2", "return 3");

async function cli(
  args: string[],
  options: { cwd?: string; stdin?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BUN, CLI, ...args], {
    cwd: options.cwd ?? workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : "pipe",
  });
  if (options.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function json<T>(result: { stdout: string }): T {
  return JSON.parse(result.stdout) as T;
}

async function http<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(route, opened.url), {
    ...init,
    headers: { "content-type": "application/json" },
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

beforeAll(async () => {
  workspace = await tempDir("patch-workspace");
  otherDir = await tempDir("patch-other");
  gitWorkspace = await initRepo();
  stateHome = await tempDir("patch-state");
  env = {
    ...process.env,
    PREDIFF_STATE_DIR: stateHome,
    PREDIFF_NO_BROWSER: "1",
  } as Record<string, string>;
  await write(gitWorkspace, "app.ts", "export const value = 1;\n");
  await commitAll(gitWorkspace, "base");
  await write(gitWorkspace, "app.ts", "export const value = 2;\n");
});

afterAll(async () => {
  await cli(["stop", "--json"], { timeoutMs: 10_000 }).catch(() => {});
  await cli(["stop", "--json"], { cwd: gitWorkspace, timeoutMs: 10_000 }).catch(() => {});
  await cleanup(workspace, otherDir, gitWorkspace, stateHome);
});

test("follow-up commands never create an empty session", async () => {
  const result = await cli(["comments", "--json"], { cwd: otherDir });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("no active prediff review");
});

test("invalid stdin is rejected before a session is created", async () => {
  const result = await cli(["open", "-", "--json"], {
    cwd: otherDir,
    stdin: "not a unified diff\n",
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("expected unified diff");
  expect((await cli(["status", "--json"], { cwd: otherDir })).code).toBe(1);
});

test("open - creates an implicit patch session outside Git", async () => {
  const result = await cli(["open", "-", "--json"], { stdin: PATCH_V1 });
  expect(result.code).toBe(0);
  opened = json<OpenResult>(result);
  expect(opened.session_id).toMatch(/^sess_/);
  expect(opened.files).toBe(1);
  expect(opened.additions).toBe(1);
  expect(opened.deletions).toBe(1);

  const session = await http<Session>("/api/session");
  expect(session.source_kind).toBe("patch");
  expect(session.range).toBe("patch");
  const manifest = await http<{ files: { path: string }[] }>("/api/diff");
  expect(manifest.files.map((file) => file.path)).toEqual(["app.ts"]);
}, 20_000);

test("follow-up commands discover the active session from the directory", async () => {
  const status = json<StatusResult>(await cli(["status", "--json"]));
  expect(status.session_id).toBe(opened.session_id);
  expect(status.revision).toBe(1);
});

test("full context is explicitly unavailable for patch snapshots", async () => {
  const response = await fetch(
    new URL("/api/file?path=app.ts&side=new", opened.url),
  );
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("full new-side content unavailable");
});

test("browser reopen keeps the current patch source", async () => {
  await http("/api/session/mark-ready", { method: "POST", body: "{}" });
  const reopened = await http<OpenResult>("/api/open", { method: "POST", body: "{}" });
  expect(reopened.session_id).toBe(opened.session_id);
  expect(reopened.session_state).toBe("reviewing");
  expect(reopened.revision).toBe(1);
});

test("refresh --patch - records a new revision and preserves comments", async () => {
  const comment = await http<ReviewComment>("/api/comments", {
    method: "POST",
    body: JSON.stringify({
      file: "app.ts",
      line: 2,
      side: "new",
      text: "Please reconsider this value",
    }),
  });
  expect(comment.anchor.lines).toEqual(["  return 2;"]);

  const refreshed = json<{ changed: boolean; revision: number }>(
    await cli(["refresh", "--patch", "-", "--json"], { stdin: PATCH_V2 }),
  );
  expect(refreshed).toMatchObject({ changed: true, revision: 2 });
  const updated = await http<ReviewComment>(`/api/comments/${comment.id}`);
  expect(updated.revision).toBe(2);
  expect(updated.anchor.lines).toEqual(["  return 3;"]);
});

test("--session selects the review from another directory", async () => {
  const status = json<StatusResult>(
    await cli(["status", "--session", opened.session_id, "--json"], { cwd: otherDir }),
  );
  expect(status.session_id).toBe(opened.session_id);
  expect(status.revision).toBe(2);
});

test("--patch FILE opens another autogenerated patch session", async () => {
  const file = path.join(workspace, "changes.diff");
  await write(workspace, "changes.diff", PATCH_V2);
  const result = json<OpenResult>(await cli(["open", "--patch", file, "--json"]));
  // The current patch-backed review is resumed rather than creating noise.
  expect(result.session_id).toBe(opened.session_id);
  expect(result.revision).toBe(2);
});

test("--session can switch between Git and patch reviews in one workspace", async () => {
  const gitReview = json<OpenResult>(
    await cli(["open", "working", "--json"], { cwd: gitWorkspace }),
  );
  const patchReview = json<OpenResult>(
    await cli(["open", "-", "--json"], { cwd: gitWorkspace, stdin: PATCH_V1 }),
  );
  expect(patchReview.session_id).not.toBe(gitReview.session_id);
  await write(gitWorkspace, "app.ts", "export const value = 3;\n");

  const selectedGit = json<StatusResult>(
    await cli(["status", "--session", gitReview.session_id, "--json"], { cwd: otherDir }),
  );
  expect(selectedGit.range).toBe("working");
  expect(selectedGit.revision).toBe(2);

  const selectedPatch = json<StatusResult>(
    await cli(["status", "--session", patchReview.session_id, "--json"], { cwd: otherDir }),
  );
  expect(selectedPatch.range).toBe("patch");
}, 20_000);
