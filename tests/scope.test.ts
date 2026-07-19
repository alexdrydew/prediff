/**
 * Content-aware out-of-scope flagging (QA gap §1.2 rework). The heuristic is
 * server-side now: a file is in scope when scope keywords overlap its PATH
 * tokens OR tokens in its DIFF CONTENT (changed lines, camelCase-split
 * identifiers). Directory affinity, >50% suppression, informational-only and
 * reason strings are retained; --scope-files globs replace the heuristic.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DiffManifest } from "../src/types";
import { changedLinesText, computeScopeFlags, scopeKeywords } from "../src/scope";
import { Daemon } from "../src/server/server";
import { cleanup, commitAll, initRepo, tempDir, write } from "./helpers";

describe("scopeKeywords", () => {
  test("stopwords and short words are dropped; camelCase splits", () => {
    expect(scopeKeywords("fix the login bug")).toEqual(["login"]);
    expect(scopeKeywords("harden validateUrl")).toEqual(["harden", "validate", "url"]);
  });
});

describe("content-aware heuristic (QA §1.2 rework)", () => {
  const SCOPE = "add collision-safe code generation and URL validation";

  test("tester's shortener case: shorten.ts wires the validation in — must NOT flag; README rewrite MUST flag", () => {
    const flags = computeScopeFlags(
      [
        { path: "src/codes.ts", diff_text: "function makeCode() {\n  retry();\n}" },
        { path: "src/validate.ts", diff_text: "export function validateUrl(u: string) {}" },
        {
          // The most in-scope file of the change — but its PATH shares no
          // keyword with the scope. Its diff content does.
          path: "src/routes/shorten.ts",
          diff_text: "  if (!validateUrl(url)) {\n    return badRequest();\n  }",
        },
        { path: "src/routes/stats.ts", diff_text: "  res.send(counts);" },
        {
          path: "README.md",
          diff_text: "# demo\nComplete rewrite of the project documentation.\nUsage notes.",
        },
      ],
      SCOPE,
      null,
    );
    expect(flags.get("src/routes/shorten.ts")).toBeUndefined();
    expect(flags.get("src/codes.ts")).toBeUndefined();
    expect(flags.get("src/validate.ts")).toBeUndefined();
    expect(flags.get("src/routes/stats.ts")).toBeUndefined(); // dir affinity with shorten.ts
    expect(flags.get("README.md")).toContain(SCOPE);
    expect(flags.size).toBe(1);
  });

  test("QA case 1 (caching task): db.py must NOT flag — directory affinity retained", () => {
    const flags = computeScopeFlags(
      [{ path: "src/db.py" }, { path: "src/cache.py" }, { path: "src/pagination.py" }],
      "add caching to db queries",
      null,
    );
    expect(flags.size).toBe(0);
  });

  test("QA case 2 (migrate api endpoints, 30/32 would flag): ALL flags suppressed", () => {
    const files = [
      { path: "src/api/client.py" },
      { path: "docs/api.md" },
      ...Array.from({ length: 30 }, (_, i) => ({ path: `src/module${i}/handler${i}.py` })),
    ];
    expect(computeScopeFlags(files, "migrate api endpoints to v2", null).size).toBe(0);
  });

  test("no scope → nothing flagged; unrelated files in other dirs still flag", () => {
    expect(computeScopeFlags([{ path: "src/x.py" }], null, null).size).toBe(0);
    const flags = computeScopeFlags(
      [
        { path: "src/auth/login.py" },
        { path: "src/auth/session.py" },
        { path: "ops/deploy.yaml", diff_text: "replicas: 3" },
      ],
      "fix the login bug in auth",
      null,
    );
    expect(flags.size).toBe(1);
    expect(flags.get("ops/deploy.yaml")).toBeDefined();
  });

  test("a content-matched file spreads directory affinity like a path match", () => {
    const flags = computeScopeFlags(
      [
        { path: "app/handlers.py", diff_text: "def rate_limit(req):" },
        { path: "app/helpers.py", diff_text: "def fmt(x):" },
        { path: "scripts/cleanup.sh", diff_text: "rm -rf tmp" },
      ],
      "introduce rate limiting",
      null,
    );
    expect(flags.get("app/handlers.py")).toBeUndefined(); // content match
    expect(flags.get("app/helpers.py")).toBeUndefined(); // same dir
    expect(flags.get("scripts/cleanup.sh")).toBeDefined();
  });

  test("--scope-files globs replace the heuristic entirely (content ignored)", () => {
    const flags = computeScopeFlags(
      [
        { path: "src/lib/a.ts", diff_text: "unrelated()" },
        { path: "src/routes/admin.ts", diff_text: "validateUrl(url)" },
      ],
      "url validation",
      ["src/lib/**"],
    );
    expect(flags.get("src/lib/a.ts")).toBeUndefined();
    expect(flags.get("src/routes/admin.ts")).toContain("src/lib/**");
  });
});

describe("changedLinesText", () => {
  test("keeps only +/- hunk lines, strips markers, drops headers and context", () => {
    const section = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " context line",
      "-old line",
      "+new validateUrl(url)",
      " more context",
    ].join("\n");
    expect(changedLinesText(section)).toBe("old line\nnew validateUrl(url)");
    expect(changedLinesText(undefined)).toBe("");
  });
});

describe("manifest carries server-computed scope_flag", () => {
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

  beforeAll(async () => {
    repo = await initRepo();
    stateDir = await tempDir("state");
    await write(repo, "src/routes/shorten.ts", "export function shorten(url: string) {\n  return url;\n}\n");
    await write(repo, "README.md", "# demo\n");
    await commitAll(repo, "base");
    await write(
      repo,
      "src/routes/shorten.ts",
      "export function shorten(url: string) {\n  if (!validateUrl(url)) throw new Error();\n  return url;\n}\n",
    );
    await write(repo, "README.md", "# demo\nTotally rewritten introduction and usage notes.\n");

    daemon = new Daemon({ repoRoot: repo, stateDir, range: "working", ttlMs: 0 });
    await daemon.start();
    url = daemon.url;
    (daemon as unknown as { watcher: { stop(): void } }).watcher.stop();
  });

  afterAll(async () => {
    await daemon.close();
    await cleanup(repo, stateDir);
  });

  test("no scope → no flags; setting a scope via /api/open annotates the manifest", async () => {
    const before = await http<DiffManifest>("/api/diff");
    expect(before.files.every((f) => f.scope_flag === undefined)).toBe(true);

    await http("/api/open", {
      method: "POST",
      body: JSON.stringify({ scope: "add collision-safe code generation and URL validation" }),
    });
    const after = await http<DiffManifest>("/api/diff");
    const shorten = after.files.find((f) => f.path === "src/routes/shorten.ts")!;
    const readme = after.files.find((f) => f.path === "README.md")!;
    expect(shorten.scope_flag).toBeUndefined(); // content-matched: validateUrl
    expect(readme.scope_flag).toMatchObject({ flagged: true });
    expect(readme.scope_flag!.reason).toContain("informational only");
  });

  test("flags survive a refresh (recomputed against the new diff)", async () => {
    await write(repo, "README.md", "# demo\nRewritten again, still unrelated.\n");
    await http("/api/refresh", { method: "POST", body: "{}" });
    const manifest = await http<DiffManifest>("/api/diff");
    expect(manifest.files.find((f) => f.path === "README.md")!.scope_flag).toMatchObject({
      flagged: true,
    });
    expect(
      manifest.files.find((f) => f.path === "src/routes/shorten.ts")!.scope_flag,
    ).toBeUndefined();
  });
});
