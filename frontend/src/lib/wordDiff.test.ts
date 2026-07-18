import { describe, expect, test } from "bun:test";
import { changedRanges, markHighlightedHtml, wordDiff } from "./wordDiff";

describe("wordDiff (§3.2 word-level highlighting)", () => {
  test("single token change is isolated", () => {
    const d = wordDiff(
      "    if user.password != password:",
      "    if user.password != hashed:",
    );
    expect(d).not.toBeNull();
    expect(d!.old.filter((s) => s.changed).map((s) => s.text)).toEqual(["password"]);
    expect(d!.new.filter((s) => s.changed).map((s) => s.text)).toEqual(["hashed"]);
  });

  test("multiple changed tokens, common structure kept", () => {
    const d = wordDiff("return hash(pw, 100000)", "return hash(pw, 600000)")!;
    expect(d.old.filter((s) => s.changed).map((s) => s.text)).toEqual(["100000"]);
    expect(d.new.filter((s) => s.changed).map((s) => s.text)).toEqual(["600000"]);
  });

  test("completely different lines produce no marks (noise guard)", () => {
    expect(wordDiff("import hashlib", "return create_session(user)")).toBeNull();
  });

  test("identical lines produce no marks", () => {
    expect(wordDiff("same", "same")).toBeNull();
  });

  test("oversized lines fall back to no marks", () => {
    const big = "x".repeat(2000);
    expect(wordDiff(big, `${big}y`)).toBeNull();
  });

  test("changedRanges maps segments to char offsets", () => {
    const d = wordDiff("a + b", "a + c")!;
    expect(changedRanges(d.new)).toEqual([[4, 5]]);
  });
});

describe("markHighlightedHtml", () => {
  test("wraps plain ranges", () => {
    expect(markHighlightedHtml("hello world", [[6, 11]])).toBe(
      'hello <span class="wm">world</span>',
    );
  });

  test("re-opens marks across tag boundaries (valid nesting)", () => {
    const html = '<span class="hljs-keyword">let</span> x = 1';
    // mark "let x" (chars 0–5)
    const out = markHighlightedHtml(html, [[0, 5]]);
    expect(out).toBe(
      '<span class="hljs-keyword"><span class="wm">let</span></span><span class="wm"> x</span> = 1',
    );
  });

  test("entities count as one char", () => {
    const html = "a &amp;&amp; b";
    // plain text "a && b": mark "&&" (chars 2–4)
    const out = markHighlightedHtml(html, [[2, 4]]);
    expect(out).toBe('a <span class="wm">&amp;&amp;</span> b');
  });

  test("no ranges → unchanged", () => {
    expect(markHighlightedHtml("<b>x</b>", [])).toBe("<b>x</b>");
  });
});
