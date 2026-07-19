import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic, readJson } from "../src/store/atomic";
import { anchorWindowIntact, buildAnchor, reanchor, reanchorOutcome } from "../src/store/anchor";
import { repoId, sessionPath } from "../src/store/paths";
import { SessionStore, addComment, resolveComment } from "../src/store/session";
import { cleanup, tempDir } from "./helpers";

let dir: string;

beforeAll(async () => {
  dir = await tempDir("store");
});

afterAll(async () => {
  await cleanup(dir);
});

describe("atomic writes", () => {
  test("write + read round-trip", async () => {
    const p = path.join(dir, "a.json");
    await writeJsonAtomic(p, { x: 1 });
    expect(await readJson<{ x: number }>(p)).toEqual({ x: 1 });
  });

  test("no temp files left behind, even under concurrent writers", async () => {
    const p = path.join(dir, "b.json");
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => writeJsonAtomic(p, { i, pad: "x".repeat(2000) })),
    );
    const value = await readJson<{ i: number; pad: string }>(p);
    expect(value).not.toBeNull();
    expect(value!.pad.length).toBe(2000); // never a torn read
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("corrupt file reads as null instead of throwing", async () => {
    const p = path.join(dir, "corrupt.json");
    await Bun.write(p, "{ not json");
    expect(await readJson(p)).toBeNull();
  });
});

describe("repo id", () => {
  test("is 12 hex chars of sha256(realpath)", async () => {
    const id = await repoId(dir);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(await repoId(dir)).toBe(id); // stable
  });
});

describe("session store", () => {
  test("create, mutate, persist on every mutation", async () => {
    const stateDir = await tempDir("state");
    try {
      const store = new SessionStore(stateDir);
      const session = await store.create("/some/repo", "working");
      expect((await store.loadCurrent())?.session_id).toBe(session.session_id);

      const comment = addComment(
        session,
        { file: "a.ts", line: 3, kind: "line", text: "why?" },
        { context_before: ["1", "2"], lines: ["3"], context_after: ["4"] },
      );
      await store.save(session);

      // A fresh store instance sees the comment (durability).
      const reloaded = await new SessionStore(stateDir).loadCurrent();
      expect(reloaded!.comments.length).toBe(1);
      expect(reloaded!.comments[0]!.text).toBe("why?");
      expect(reloaded!.comments[0]!.state).toBe("draft");

      resolveComment(session, comment.id, { from: "agent", text: "fixed" });
      await store.save(session);
      const again = await new SessionStore(stateDir).load(session.session_id);
      expect(again!.comments[0]!.state).toBe("resolved");
      expect(again!.comments[0]!.replies[0]!.text).toBe("fixed");

      // Session file lives where ARCHITECTURE.md says.
      expect(await Bun.file(sessionPath(stateDir, session.session_id)).exists()).toBe(true);
    } finally {
      await cleanup(stateDir);
    }
  });
});

describe("re-anchoring", () => {
  const content = ["import x", "", "function foo() {", "  return 1;", "}", "", "const z = 2;"];

  test("exact match survives lines inserted above", () => {
    const anchor = buildAnchor(content, 4, 4); // "  return 1;"
    const shifted = ["// new header", "// more", ...content];
    const m = reanchor(anchor, shifted, 4);
    expect(m).toEqual({ line: 6, end_line: 6 });
  });

  test("multi-line anchor", () => {
    const anchor = buildAnchor(content, 3, 5); // whole function
    const shifted = ["a", "b", "c", ...content];
    const m = reanchor(anchor, shifted, 3);
    expect(m).toEqual({ line: 6, end_line: 8 });
  });

  test("fuzzy match when context edited (fuzz drops outer context)", () => {
    const anchor = buildAnchor(content, 4, 4);
    // Change a context line 2 above ("") and 2 below ("") — fuzz 2 required.
    const edited = [...content];
    edited[1] = "import y"; // context_before outermost
    edited[5] = "// trailing"; // context_after outermost... index 5 is ""
    const m = reanchor(anchor, edited, 4);
    expect(m).toEqual({ line: 4, end_line: 4 });
  });

  test("prefers the match nearest the original location", () => {
    const block = ["  return 1;"];
    const anchor = { context_before: [], lines: block, context_after: [] };
    const many = ["  return 1;", "x", "  return 1;", "y", "  return 1;"];
    expect(reanchor(anchor, many, 3)).toEqual({ line: 3, end_line: 3 });
    expect(reanchor(anchor, many, 1)).toEqual({ line: 1, end_line: 1 });
    expect(reanchor(anchor, many, 5)).toEqual({ line: 5, end_line: 5 });
  });

  test("no match → null (caller marks comment orphaned)", () => {
    const anchor = buildAnchor(content, 4, 4);
    const rewritten = ["completely", "different", "file"];
    expect(reanchor(anchor, rewritten, 4)).toBeNull();
  });

  test("commented line deleted → null even with fuzz", () => {
    const anchor = buildAnchor(content, 4, 4);
    const withoutLine = content.filter((l) => l !== "  return 1;");
    expect(reanchor(anchor, withoutLine, 4)).toBeNull();
  });

  test("anchor at file boundaries (no context available)", () => {
    const anchor = buildAnchor(content, 1, 1);
    expect(anchor.context_before).toEqual([]);
    const shifted = ["pad", ...content];
    expect(reanchor(anchor, shifted, 1)).toEqual({ line: 2, end_line: 2 });
  });
});

describe("three-outcome re-anchoring (spec §6.4)", () => {
  const content = ["import x", "", "function foo() {", "  return 1;", "}", "", "const z = 2;"];

  test("unchanged / shifted → match", () => {
    const anchor = buildAnchor(content, 4, 4);
    expect(reanchorOutcome(anchor, content, 4)).toEqual({ kind: "match", line: 4, end_line: 4 });
    expect(reanchorOutcome(anchor, ["a", "b", ...content], 4)).toEqual({
      kind: "match",
      line: 6,
      end_line: 6,
    });
  });

  test("anchored line rewritten between intact context → modified", () => {
    const anchor = buildAnchor(content, 4, 4);
    const edited = [...content];
    edited[3] = "  return compute();";
    expect(reanchorOutcome(anchor, edited, 4)).toEqual({ kind: "modified", line: 4, end_line: 4 });
  });

  test("region replaced by a longer block → modified, spanning the new block", () => {
    const anchor = buildAnchor(content, 4, 4);
    const edited = [...content.slice(0, 3), "  const r = 1;", "  audit(r);", "  return r;", ...content.slice(4)];
    expect(reanchorOutcome(anchor, edited, 4)).toEqual({ kind: "modified", line: 4, end_line: 6 });
  });

  test("region deleted with context intact → lost (orphaned, not misattached)", () => {
    const anchor = buildAnchor(content, 4, 4);
    const deleted = content.filter((l) => l !== "  return 1;");
    expect(reanchorOutcome(anchor, deleted, 4)).toEqual({ kind: "lost" });
  });

  test("file rewritten entirely → lost", () => {
    const anchor = buildAnchor(content, 4, 4);
    expect(reanchorOutcome(anchor, ["completely", "different"], 4)).toEqual({ kind: "lost" });
  });

  test("replacement grown beyond the confidence bound → lost", () => {
    const anchor = buildAnchor(content, 4, 4);
    const huge = [
      ...content.slice(0, 3),
      ...Array.from({ length: 100 }, (_, i) => `  line${i};`),
      ...content.slice(4),
    ];
    expect(reanchorOutcome(anchor, huge, 4)).toEqual({ kind: "lost" });
  });
});

describe("full-window drift detection (QA bug §2.1)", () => {
  const content = ["import x", "", "function foo() {", "  return 1;", "}", "", "const z = 2;"];

  test("unchanged and shifted windows are intact", () => {
    const anchor = buildAnchor(content, 4, 4);
    expect(anchorWindowIntact(anchor, content, 4)).toBe(true);
    expect(anchorWindowIntact(anchor, ["a", "b", ...content], 6)).toBe(true);
  });

  test("context rewritten around a preserved line → drift", () => {
    const anchor = buildAnchor(content, 4, 4);
    // The commented line survives verbatim, but its function was rewritten.
    const rewritten = ["import x", "", "function foo(n: number) {", "  if (n) log(n);", "  return 1;", "}", "", "const z = 2;"];
    expect(anchorWindowIntact(anchor, rewritten, 5)).toBe(false);
  });

  test("windows clipped by file boundaries compare only captured context", () => {
    const anchor = buildAnchor(content, 1, 1); // no context_before exists
    expect(anchor.context_before).toEqual([]);
    // Prepending lines shifts the anchor; nothing above was ever captured.
    expect(anchorWindowIntact(anchor, ["// new", ...content], 2)).toBe(true);
    // A window that would run past EOF is drift, not a crash.
    const tail = buildAnchor(content, 7, 7);
    expect(anchorWindowIntact(tail, content.slice(0, 6), 7)).toBe(false);
  });
});
