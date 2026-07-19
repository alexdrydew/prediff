/**
 * Applyable suggestions (QA gap §1.5): an additive `suggestion` field —
 * the reviewer's exact replacement text for the anchored line range —
 * exposed through the API and GET /api/comments/:id/suggestion (CLI:
 * `prediff suggestion <id>`). prediff never applies it to files itself.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReviewComment, SuggestionResult } from "../src/types";
import { Daemon } from "../src/server/server";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

const APP = [
  "export function add(a: number, b: number) {",
  "  return a - b;",
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

describe("suggestion field (QA §1.5)", () => {
  let withSuggestion: ReviewComment;
  let plain: ReviewComment;

  test("created with the comment; defaults to null", async () => {
    withSuggestion = await http<ReviewComment>("/api/comments", {
      method: "POST",
      body: JSON.stringify({
        file: "src/app.ts",
        line: 2,
        text: "should add, not subtract",
        tag: "suggestion",
        suggestion: "  return a + b;",
      }),
    });
    expect(withSuggestion.suggestion).toBe("  return a + b;");

    plain = await http<ReviewComment>("/api/comments", {
      method: "POST",
      body: JSON.stringify({ file: "src/app.ts", line: 1, text: "no concrete change" }),
    });
    expect(plain.suggestion).toBeNull();
  });

  test("PATCH sets and clears a suggestion on drafts", async () => {
    const set = await http<ReviewComment>(`/api/comments/${plain.id}`, {
      method: "PATCH",
      body: JSON.stringify({ suggestion: "export function add(a: number, b: number): number {" }),
    });
    expect(set.suggestion).toContain(": number {");
    const cleared = await http<ReviewComment>(`/api/comments/${plain.id}`, {
      method: "PATCH",
      body: JSON.stringify({ suggestion: null }),
    });
    expect(cleared.suggestion).toBeNull();
  });

  test("rejected on review-level comments and file notes", async () => {
    expect(
      await httpStatus("/api/comments", {
        method: "POST",
        body: JSON.stringify({ text: "overall", suggestion: "x" }),
      }),
    ).toBe(400);
    expect(
      await httpStatus("/api/comments", {
        method: "POST",
        body: JSON.stringify({ file: "src/app.ts", line: 0, text: "note", suggestion: "x" }),
      }),
    ).toBe(400);
    const note = await http<ReviewComment>("/api/comments", {
      method: "POST",
      body: JSON.stringify({ file: "src/app.ts", line: 0, text: "note" }),
    });
    expect(
      await httpStatus(`/api/comments/${note.id}`, {
        method: "PATCH",
        body: JSON.stringify({ suggestion: "x" }),
      }),
    ).toBe(400);
    await http(`/api/comments/${note.id}`, { method: "DELETE" });
  });

  test("GET /api/comments/:id/suggestion returns the current lines + replacement", async () => {
    const s = await http<SuggestionResult>(`/api/comments/${withSuggestion.id}/suggestion`);
    expect(s).toEqual({
      id: withSuggestion.id,
      file: "src/app.ts",
      line: 2,
      end_line: 2,
      side: "new",
      current_lines: ["  return a - b;"],
      suggestion: "  return a + b;",
    });
  });

  test("current_lines track the file as it exists NOW (after re-anchoring)", async () => {
    // Shift the anchored line down; the suggestion follows the comment.
    await write(repo, "src/app.ts", "// header\n" + APP);
    await http("/api/refresh", { method: "POST", body: "{}" });
    const s = await http<SuggestionResult>(`/api/comments/${withSuggestion.id}/suggestion`);
    expect(s.line).toBe(3);
    expect(s.current_lines).toEqual(["  return a - b;"]);
    expect(s.suggestion).toBe("  return a + b;");
  });

  test("comments without a suggestion are a 400; unknown ids 404", async () => {
    expect(await httpStatus(`/api/comments/${plain.id}/suggestion`)).toBe(400);
    expect(await httpStatus("/api/comments/nope/suggestion")).toBe(404);
  });

  test("suggestions ride along in /api/comments output", async () => {
    await http(`/api/comments/${withSuggestion.id}/send`, { method: "POST", body: "{}" });
    const { comments } = await http<{ comments: ReviewComment[] }>("/api/comments");
    const c = comments.find((x) => x.id === withSuggestion.id)!;
    expect(c.suggestion).toBe("  return a + b;");
  });
});
