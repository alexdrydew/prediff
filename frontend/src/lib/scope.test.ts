import { describe, expect, test } from "bun:test";
import { computeScopeFlags, globToRegExp, matchesAnyGlob, scopeKeywords } from "./scope";

describe("scopeKeywords", () => {
  test("no scope → no keywords", () => {
    expect(scopeKeywords(null)).toEqual([]);
    expect(scopeKeywords("  ")).toEqual([]);
  });

  test("stopwords and short words are dropped from the scope", () => {
    expect(scopeKeywords("fix the login bug")).toEqual(["login"]);
  });
});

describe("out-of-scope heuristic (§9.4, QA F2 rework)", () => {
  test("no scope → nothing flagged", () => {
    expect(computeScopeFlags(["src/anything.py"], null, null).size).toBe(0);
    expect(computeScopeFlags(["src/anything.py"], "", null).size).toBe(0);
  });

  test("QA case 1 (caching task): db.py must NOT flag — it shares a directory with the matched cache.py", () => {
    const flags = computeScopeFlags(
      ["src/db.py", "src/cache.py", "src/pagination.py"],
      "add caching to db queries",
      null,
    );
    expect(flags.get("src/db.py")).toBeUndefined();
    expect(flags.size).toBe(0);
  });

  test("QA case 2 (migrate api endpoints to v2, 30/32 would flag): ALL flags suppressed", () => {
    // 32 files; only 2 mention "api" — the old heuristic flagged the other 30.
    const paths = [
      "src/api/client.py",
      "docs/api.md",
      ...Array.from({ length: 30 }, (_, i) => `src/module${i}/handler${i}.py`),
    ];
    const flags = computeScopeFlags(paths, "migrate api endpoints to v2", null);
    expect(flags.size).toBe(0);
  });

  test("genuinely unrelated files in other directories still flag (with a tooltip reason)", () => {
    const flags = computeScopeFlags(
      ["src/auth/login.py", "src/auth/session.py", "ops/deploy.yaml"],
      "fix the login bug in auth",
      null,
    );
    expect(flags.size).toBe(1);
    expect(flags.get("ops/deploy.yaml")).toContain("fix the login bug in auth");
  });

  test("directory segments count as matches, not just the basename", () => {
    const flags = computeScopeFlags(
      ["src/billing/utils.py", "src/frontend/theme.css"],
      "rework billing edge cases",
      null,
    );
    expect(flags.get("src/billing/utils.py")).toBeUndefined();
    // 1 of 2 flagged (not > 50%) → the unrelated file keeps its flag.
    expect(flags.get("src/frontend/theme.css")).toBeDefined();
  });

  test("substring matching works both ways (auth ↔ authentication)", () => {
    const flags = computeScopeFlags(
      ["lib/authentication.py", "lib/other.py"],
      "harden auth flows",
      null,
    );
    expect(flags.get("lib/authentication.py")).toBeUndefined();
    expect(flags.get("lib/other.py")).toBeUndefined(); // same dir as a match
  });

  test("extension never counts as a token", () => {
    const flags = computeScopeFlags(["a/thing.py", "b/other.ts"], "improve py tooling", null);
    // Nothing matches "py"/"tooling" → 2/2 would flag → suppressed anyway;
    // check via a mixed set where suppression doesn't kick in.
    const mixed = computeScopeFlags(
      ["tooling/setup.sh", "tooling/run.sh", "a/thing.py"],
      "improve py tooling",
      null,
    );
    expect(flags.size).toBe(0);
    expect(mixed.get("a/thing.py")).toBeDefined();
  });
});

describe("--scope-files globs replace the heuristic", () => {
  const patterns = ["src/lib/**", "src/routes/users.ts"];

  test("files matching no pattern are flagged, regardless of scope text overlap", () => {
    const flags = computeScopeFlags(
      ["src/lib/a/b.ts", "src/routes/users.ts", "src/routes/admin.ts"],
      "users work", // would keep admin.ts unflagged under the heuristic? irrelevant
      patterns,
    );
    expect(flags.get("src/lib/a/b.ts")).toBeUndefined();
    expect(flags.get("src/routes/users.ts")).toBeUndefined();
    expect(flags.get("src/routes/admin.ts")).toContain("src/lib/**");
  });

  test("no majority suppression in explicit mode", () => {
    const flags = computeScopeFlags(
      ["a.ts", "b.ts", "c.ts", "src/lib/x.ts"],
      null,
      ["src/lib/**"],
    );
    expect(flags.size).toBe(3);
  });
});

describe("glob matcher", () => {
  test("** crosses directory separators", () => {
    expect(globToRegExp("src/lib/**").test("src/lib/deep/nested/file.ts")).toBe(true);
    expect(globToRegExp("src/lib/**").test("src/other/file.ts")).toBe(false);
  });

  test("* stays within a segment", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/dir/a.ts")).toBe(false);
  });

  test("? matches a single non-separator character", () => {
    expect(globToRegExp("v?.md").test("v1.md")).toBe(true);
    expect(globToRegExp("v?.md").test("v12.md")).toBe(false);
  });

  test("literal patterns match exactly (regex metachars escaped)", () => {
    expect(globToRegExp("src/a+b.ts").test("src/a+b.ts")).toBe(true);
    expect(globToRegExp("src/a+b.ts").test("src/aab.ts")).toBe(false);
  });

  test("matchesAnyGlob", () => {
    expect(matchesAnyGlob("src/lib/x.ts", ["docs/**", "src/lib/**"])).toBe(true);
    expect(matchesAnyGlob("README.md", ["docs/**", "src/lib/**"])).toBe(false);
  });
});
