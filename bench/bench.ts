#!/usr/bin/env bun
/**
 * Benchmark skeleton (ARCHITECTURE.md "Performance targets").
 *
 * Generates a synthetic repo with a parameterized N-line diff, then measures:
 *   - `prediff open` → URL printed (cold daemon)
 *   - `prediff open` again (warm daemon)
 *   - GET /api/diff (manifest) latency
 *   - GET /api/diff/file latency (largest file)
 *   - `prediff status` CLI round-trip
 *
 * Usage: bun bench/bench.ts [--lines 10000] [--files 20] [--keep]
 * Browser render timings (Playwright) come later, with the real frontend.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenResult } from "../src/types";

const CLI = path.join(import.meta.dir, "..", "src", "cli", "index.ts");
const BUN = process.execPath;

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i !== -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

const LINES = flag("lines", 10_000);
const FILES = flag("files", 20);
const KEEP = process.argv.includes("--keep");

async function sh(cwd: string, cmd: string[], env?: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err}`);
  return out;
}

async function generateRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prediff-bench-"));
  await sh(dir, ["git", "init", "-q", "-b", "main"]);
  await sh(dir, ["git", "config", "user.email", "bench@prediff.local"]);
  await sh(dir, ["git", "config", "user.name", "bench"]);

  const linesPerFile = Math.ceil(LINES / FILES);
  for (let f = 0; f < FILES; f++) {
    const body = Array.from(
      { length: linesPerFile * 2 },
      (_, i) => `const line_${f}_${i} = ${i}; // some representative content ${"x".repeat(20)}`,
    ).join("\n");
    await Bun.write(path.join(dir, `src/file${f}.ts`), body + "\n");
  }
  await sh(dir, ["git", "add", "-A"]);
  await sh(dir, ["git", "commit", "-q", "-m", "base"]);

  // Modify every other line in the first half of each file → ~LINES changed lines.
  for (let f = 0; f < FILES; f++) {
    const p = path.join(dir, `src/file${f}.ts`);
    const lines = (await Bun.file(p).text()).split("\n");
    for (let i = 0; i < linesPerFile; i += 2) {
      lines[i] = `const line_${f}_${i} = ${i} + 1; // CHANGED ${"y".repeat(20)}`;
    }
    await Bun.write(p, lines.join("\n"));
  }
  return dir;
}

interface Timing {
  label: string;
  ms: number;
}

async function main(): Promise<void> {
  console.log(`generating synthetic repo: ~${LINES} changed lines across ${FILES} files…`);
  const repo = await generateRepo();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prediff-bench-state-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PREDIFF_STATE_DIR: stateDir,
    PREDIFF_NO_BROWSER: "1",
  };
  const timings: Timing[] = [];
  const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const result = await fn();
    timings.push({ label, ms: performance.now() - t0 });
    return result;
  };

  try {
    const openOut = await time("open → URL (cold daemon)", () =>
      sh(repo, [BUN, CLI, "open", "working", "--json"], env),
    );
    const opened = JSON.parse(openOut) as OpenResult;
    console.log(`session: ${opened.files} files, +${opened.additions} -${opened.deletions}`);

    await time("open → URL (warm daemon)", () =>
      sh(repo, [BUN, CLI, "open", "working", "--json"], env),
    );

    for (let i = 0; i < 3; i++) {
      await time(`GET /api/diff (manifest) #${i + 1}`, async () => {
        const res = await fetch(new URL("/api/diff", opened.url));
        await res.json();
      });
    }

    await time("GET /api/diff/file (one file)", async () => {
      const res = await fetch(
        new URL(`/api/diff/file?path=${encodeURIComponent("src/file0.ts")}`, opened.url),
      );
      await res.json();
    });

    await time("CLI status round-trip", () => sh(repo, [BUN, CLI, "status", "--json"], env));

    console.log("\nresults:");
    for (const t of timings) {
      console.log(`  ${t.label.padEnd(36)} ${t.ms.toFixed(1).padStart(8)} ms`);
    }
  } finally {
    await sh(repo, [BUN, CLI, "stop", "--json"], env).catch(() => {});
    if (KEEP) {
      console.log(`\nkept: repo=${repo} state=${stateDir}`);
    } else {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
