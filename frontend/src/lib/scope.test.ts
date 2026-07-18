import { describe, expect, test } from "bun:test";
import { outsideScope, scopeKeywords } from "./scope";

describe("outside-scope heuristic (§9.4)", () => {
  test("no scope → nothing flagged", () => {
    expect(scopeKeywords(null)).toEqual([]);
    expect(outsideScope("src/anything.py", [])).toBe(false);
  });

  test("stopwords and short words are dropped from the scope", () => {
    expect(scopeKeywords("fix the login bug")).toEqual(["login"]);
  });

  test("files sharing a path token with the scope are in scope", () => {
    const kw = scopeKeywords("fix the login bug in auth");
    expect(outsideScope("src/auth.py", kw)).toBe(false);
    expect(outsideScope("src/login_form.tsx", kw)).toBe(false);
    // substring either way: "authentication" contains "auth"
    expect(outsideScope("src/authentication.py", kw)).toBe(false);
  });

  test("unrelated files are flagged", () => {
    const kw = scopeKeywords("fix the login bug in auth");
    expect(outsideScope("src/config/database.py", kw)).toBe(true);
    expect(outsideScope("tests/test_migrations.py", kw)).toBe(true);
  });

  test("extension never counts as a token", () => {
    const kw = scopeKeywords("improve py tooling");
    expect(outsideScope("src/thing.py", kw)).toBe(true);
  });
});
