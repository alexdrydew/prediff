#!/usr/bin/env bun
/**
 * prediff vs difit comparison benchmark (ARCHITECTURE.md "Performance targets").
 *
 * For each diff size (~1k / 10k / 50k changed lines) and each tool, measures:
 *   - cold start: CLI invocation → server-ready/URL printed
 *   - server API latency for the data the UI needs
 *       prediff: GET /api/diff (manifest) + GET /api/diff/file (largest file)
 *       difit:   GET /api/diff (entire diff in one payload)
 *   - browser (Playwright headless Chromium):
 *       domContentLoaded, LCP (if available), first file list visible,
 *       first diff line text visible, JS heap (CDP Performance.getMetrics)
 *   - at 10k only: "full diff rendered" (prediff: expand all files;
 *     difit: full render is the default), then a scripted scroll recording
 *     long tasks and rAF-derived FPS.
 *
 * Each measurement runs `--runs` times (default 3); the median is reported.
 *
 * Usage:
 *   bun bench/compare.ts                          # full run, writes bench/RESULTS.md
 *   bun bench/compare.ts --sizes 1000,10000       # subset of sizes
 *   bun bench/compare.ts --runs 1 --skip-browser  # quick server-side smoke
 *   bun bench/compare.ts --keep                   # keep synthetic repos around
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { OpenResult } from "../src/types";

// ---------------------------------------------------------------------------
// config / CLI args

const BENCH_DIR = import.meta.dir;
const PREDIFF_CLI = path.join(BENCH_DIR, "..", "src", "cli", "index.ts");
const DIFIT_JS = path.join(BENCH_DIR, "node_modules", "difit", "dist", "cli", "index.js");
const BUN = process.execPath;
const NODE =
  Bun.which("node") ?? path.join(os.homedir(), ".nix-profile", "bin", "node");

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const SIZES = argStr("sizes", "1000,10000,50000").split(",").map(Number);
const RUNS = Number(argStr("runs", "3"));
const SKIP_BROWSER = process.argv.includes("--skip-browser");
const KEEP = process.argv.includes("--keep");
const OUT = argStr("out", path.join(BENCH_DIR, "RESULTS.md"));
const SCROLL_SIZE = 10_000; // scroll / full-render tests run at this size only
const NAV_TIMEOUT = 120_000;
const BIG_TIMEOUT = 180_000;

let nextPort = 42_300 + Math.floor(Math.random() * 200);

// ---------------------------------------------------------------------------
// helpers

const median = (xs: number[]): number => {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fmtMs = (ms: number): string => (Number.isFinite(ms) ? `${ms.toFixed(0)} ms` : "n/a");
const fmtMB = (b: number): string =>
  !Number.isFinite(b) ? "n/a" : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

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

// ---------------------------------------------------------------------------
// synthetic repo generation — deterministic, realistic-ish file spread

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS = ["src", "src/components", "src/server", "lib", "tests", "docs"];
const EXTS = [".ts", ".ts", ".tsx", ".py", ".go", ".md", ".json"];

function fileLine(ext: string, f: number, i: number, changed: boolean): string {
  const tag = changed ? "// CHANGED" : "//";
  switch (ext) {
    case ".py":
      return `value_${f}_${i} = compute_${i % 97}(state, ${i})  ${changed ? "# CHANGED" : "#"} handles case ${i}`;
    case ".go":
      return `\tresult${f}_${i} := process${i % 89}(ctx, input[${i}]) ${tag} step ${i}`;
    case ".md":
      return `- item ${f}.${i}: ${changed ? "CHANGED " : ""}documentation for feature ${i % 50} with some explanatory prose text`;
    case ".json":
      return `    "key_${f}_${i}": "${changed ? "CHANGED_" : ""}value with representative payload content ${i}",`;
    default:
      return `export const v_${f}_${i} = compute_${i % 97}(state, opts.flag${i % 13}, ${i}); ${tag} branch ${i}`;
  }
}

interface RepoInfo {
  dir: string;
  targetLines: number;
  actualAdditions: number;
  actualDeletions: number;
  fileCount: number;
  largestFile: string;
}

/**
 * Generates a repo whose working-tree diff vs HEAD has ~target changed lines
 * (additions + deletions): ~60% line modifications spread across many files
 * of varying sizes, ~30% newly added files, ~10% a deleted file.
 */
async function generateRepo(target: number): Promise<RepoInfo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `prediff-bench-${target}-`));
  await sh(dir, ["git", "init", "-q", "-b", "main"]);
  await sh(dir, ["git", "config", "user.email", "bench@prediff.local"]);
  await sh(dir, ["git", "config", "user.name", "bench"]);
  const rand = prng(target);

  const modFiles = Math.max(6, Math.round(Math.sqrt(target) / 2));
  const addFiles = Math.max(2, Math.round(modFiles / 6));
  const delFiles = Math.max(1, Math.round(modFiles / 16));
  const modChangedLines = Math.round(target * 0.6); // each modified line = +1/-1
  const addLines = Math.round(target * 0.3);
  const delLines = target - modChangedLines - addLines;

  // base files (weights → per-file share of the modification budget)
  const weights = Array.from({ length: modFiles }, () => 0.2 + rand() ** 2 * 3);
  const wSum = weights.reduce((a, b) => a + b, 0);
  const modPaths: { p: string; ext: string; modLines: number; baseLines: number }[] = [];
  for (let f = 0; f < modFiles; f++) {
    const ext = EXTS[Math.floor(rand() * EXTS.length)]!;
    const p = `${DIRS[f % DIRS.length]}/module_${f}${ext}`;
    const modLines = Math.max(1, Math.round(((modChangedLines / 2) * weights[f]!) / wSum));
    const baseLines = Math.max(30, modLines * 2 + Math.floor(rand() * 120));
    modPaths.push({ p, ext, modLines, baseLines });
    const body = Array.from({ length: baseLines }, (_, i) => fileLine(ext, f, i, false));
    await fs.mkdir(path.join(dir, path.dirname(p)), { recursive: true });
    await Bun.write(path.join(dir, p), body.join("\n") + "\n");
  }
  // files that will be deleted
  const delPaths: string[] = [];
  for (let f = 0; f < delFiles; f++) {
    const p = `lib/legacy_${f}.ts`;
    const n = Math.max(10, Math.round(delLines / delFiles));
    const body = Array.from({ length: n }, (_, i) => fileLine(".ts", 900 + f, i, false));
    await fs.mkdir(path.join(dir, "lib"), { recursive: true });
    await Bun.write(path.join(dir, p), body.join("\n") + "\n");
    delPaths.push(p);
  }
  await sh(dir, ["git", "add", "-A"]);
  await sh(dir, ["git", "commit", "-q", "-m", "base"]);

  // 1) modify lines in existing files (every other line from a random offset)
  let largestFile = modPaths[0]!.p;
  let largestMod = 0;
  for (let f = 0; f < modPaths.length; f++) {
    const { p, ext, modLines, baseLines } = modPaths[f]!;
    const abs = path.join(dir, p);
    const lines = (await Bun.file(abs).text()).split("\n");
    const start = Math.floor(rand() * Math.max(1, baseLines - modLines * 2));
    for (let k = 0; k < modLines; k++) {
      const idx = start + k * 2;
      if (idx < baseLines) lines[idx] = fileLine(ext, f, idx, true);
    }
    await Bun.write(abs, lines.join("\n"));
    if (modLines > largestMod) { largestMod = modLines; largestFile = p; }
  }
  // 2) new files (intent-to-add so both tools' "working" diff includes them)
  const perAdd = Math.max(10, Math.round(addLines / addFiles));
  for (let f = 0; f < addFiles; f++) {
    const ext = EXTS[Math.floor(rand() * EXTS.length)]!;
    const p = `src/new_feature_${f}${ext}`;
    const body = Array.from({ length: perAdd }, (_, i) => fileLine(ext, 500 + f, i, false));
    await Bun.write(path.join(dir, p), body.join("\n") + "\n");
    await sh(dir, ["git", "add", "-N", p]);
  }
  // 3) deletions
  for (const p of delPaths) await fs.rm(path.join(dir, p));

  // ground truth from git itself
  const numstat = await sh(dir, ["git", "diff", "--numstat", "HEAD"]);
  let add = 0, del = 0, files = 0;
  for (const row of numstat.trim().split("\n").filter(Boolean)) {
    const [a, d] = row.split("\t");
    files++;
    add += Number(a) || 0;
    del += Number(d) || 0;
  }
  return { dir, targetLines: target, actualAdditions: add, actualDeletions: del, fileCount: files, largestFile };
}

// ---------------------------------------------------------------------------
// tool adapters

interface RunningTool {
  name: "prediff" | "difit";
  url: string;
  /** prediff only: env (state dir) of the live daemon, for warm re-`open`. */
  env?: Record<string, string>;
  repo?: string;
  stop: () => Promise<void>;
}

async function startPrediff(repo: string): Promise<{ coldMs: number; tool: RunningTool }> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prediff-bench-state-"));
  const env = {
    ...(process.env as Record<string, string>),
    PREDIFF_STATE_DIR: stateDir,
    PREDIFF_NO_BROWSER: "1",
  };
  const t0 = performance.now();
  const out = await sh(repo, [BUN, PREDIFF_CLI, "open", "working", "--json"], env);
  const coldMs = performance.now() - t0;
  const opened = JSON.parse(out) as OpenResult;
  return {
    coldMs,
    tool: {
      name: "prediff",
      url: opened.url,
      env,
      repo,
      stop: async () => {
        await sh(repo, [BUN, PREDIFF_CLI, "stop", "--json"], env).catch(() => {});
        await fs.rm(stateDir, { recursive: true, force: true });
      },
    },
  };
}

async function startDifit(repo: string): Promise<{ coldMs: number; tool: RunningTool }> {
  const port = nextPort++;
  const t0 = performance.now();
  const proc = Bun.spawn(
    [NODE, DIFIT_JS, "working", "--no-open", "--keep-alive", "--port", String(port)],
    { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  // Keep draining stdout/stderr for the process's whole lifetime — cancelling
  // the pipe after the ready line makes difit die with EPIPE on its next log.
  void new Response(proc.stderr).text().catch(() => {});
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("difit: no ready line within 120s")), 120_000);
    let buf = "";
    let found = false;
    (async () => {
      for await (const chunk of proc.stdout) {
        buf += new TextDecoder().decode(chunk);
        if (!found) {
          const m = buf.match(/started on (http:\/\/\S+)/);
          if (m) { found = true; clearTimeout(timer); resolve(m[1]!); }
        }
      }
      if (!found) {
        clearTimeout(timer);
        reject(new Error(`difit exited before ready. output: ${buf.slice(0, 500)}`));
      }
    })().catch((err) => { if (!found) reject(err); });
    proc.exited.then((code) => {
      if (!found) {
        clearTimeout(timer);
        reject(new Error(`difit exited early (code ${code})`));
      }
    }).catch(() => {});
  });
  const coldMs = performance.now() - t0;
  return {
    coldMs,
    tool: {
      name: "difit",
      url,
      stop: async () => {
        proc.kill();
        await Promise.race([proc.exited, Bun.sleep(3000).then(() => proc.kill(9))]);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// server API measurements

interface ApiResult { ms: number; bytes: number; error?: string }

async function timedFetch(url: string): Promise<ApiResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(BIG_TIMEOUT) });
    const buf = await res.arrayBuffer();
    if (!res.ok) return { ms: NaN, bytes: 0, error: `HTTP ${res.status}` };
    return { ms: performance.now() - t0, bytes: buf.byteLength };
  } catch (err) {
    return { ms: NaN, bytes: 0, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// browser measurements

interface BrowserMetrics {
  domContentLoadedMs: number;
  lcpMs: number;
  firstRenderMs: number;    // file list / shell visible
  firstDiffLineMs: number;  // first actual diff line text visible
  heapAfterRenderBytes: number;
  fullRenderMs?: number;    // 10k only: whole diff in DOM
  scroll?: { longTasks: number; longTaskTotalMs: number; longTaskMaxMs: number; avgFps: number; heapAfterScrollBytes: number };
  error?: string;
}

const INIT_SCRIPT = `
  window.__bench = { lcp: null, longtasks: [] };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__bench.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__bench.longtasks.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  window.__fps = { frames: 0, running: false };
  window.__startFps = () => {
    window.__fps = { frames: 0, running: true, t0: performance.now() };
    const tick = () => {
      if (!window.__fps.running) return;
      window.__fps.frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  window.__stopFps = () => {
    window.__fps.running = false;
    return { frames: window.__fps.frames, ms: performance.now() - window.__fps.t0 };
  };
`;

async function heapBytes(page: Page): Promise<number> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const { metrics } = await cdp.send("Performance.getMetrics");
    await cdp.detach().catch(() => {});
    return metrics.find((m: { name: string }) => m.name === "JSHeapUsedSize")?.value ?? NaN;
  } catch {
    return NaN;
  }
}

async function browserRun(
  browser: Browser,
  tool: RunningTool,
  opts: { fullAndScroll: boolean; fileCount: number },
): Promise<BrowserMetrics> {
  const m: BrowserMetrics = {
    domContentLoadedMs: NaN, lcpMs: NaN, firstRenderMs: NaN,
    firstDiffLineMs: NaN, heapAfterRenderBytes: NaN,
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(INIT_SCRIPT);
  try {
    const t0 = performance.now();
    await page.goto(tool.url, { waitUntil: "commit", timeout: NAV_TIMEOUT });

    // shell / file list visible
    // prediff selectors cover both the React UI (.row-file) and the older
    // placeholder UI (.file .head) so the harness survives frontend evolution.
    const fileHeadSel = ".row-file, .file .head";
    const firstRenderSel = tool.name === "prediff" ? fileHeadSel : 'h3:has-text("Files changed")';
    await page.waitForSelector(firstRenderSel, { timeout: NAV_TIMEOUT });
    m.firstRenderMs = performance.now() - t0;

    // first diff line text visible (prediff collapses files by default, so
    // this includes clicking the first file open — the real user path)
    if (tool.name === "prediff") {
      await page.locator(fileHeadSel).first().click();
      await page.waitForSelector(
        ".row-line, .row-split, table.hunks tr.add, table.hunks tr.del",
        { timeout: NAV_TIMEOUT },
      );
    } else {
      await page.waitForSelector("span.token-line", { timeout: NAV_TIMEOUT });
    }
    m.firstDiffLineMs = performance.now() - t0;

    await page.waitForTimeout(1200); // settle
    const nav = await page.evaluate(() => {
      const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return {
        dcl: e ? e.domContentLoadedEventEnd - e.startTime : NaN,
        lcp: (window as unknown as { __bench: { lcp: number | null } }).__bench.lcp ?? NaN,
      };
    });
    m.domContentLoadedMs = nav.dcl;
    m.lcpMs = nav.lcp;
    m.heapAfterRenderBytes = await heapBytes(page);

    if (opts.fullAndScroll) {
      // "full diff rendered" applies to difit (renders everything up front).
      // prediff's UI is virtualized and loads hunks on demand — there is no
      // "everything in the DOM" state by design, so the metric is n/a.
      if (tool.name === "difit") m.fullRenderMs = m.firstDiffLineMs;

      // scripted scroll through the diff: same wheel distance for both tools;
      // for prediff, expand collapsed files as they come into view (the way a
      // reviewer walks a large diff).
      await page.mouse.move(720, 500);
      await page.evaluate(() => { (window as unknown as { __bench: { longtasks: number[] } }).__bench.longtasks = []; });
      await page.evaluate(() => (window as unknown as { __startFps: () => void }).__startFps());
      for (let i = 0; i < 40; i++) {
        if (tool.name === "prediff") {
          const collapsed = page.locator(".twisty", { hasText: "▸" });
          const n = Math.min(await collapsed.count(), 3);
          for (let k = 0; k < n; k++) {
            await collapsed.first().click({ timeout: 1000 }).catch(() => {});
          }
        }
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(60);
      }
      const fps = await page.evaluate(() =>
        (window as unknown as { __stopFps: () => { frames: number; ms: number } }).__stopFps(),
      );
      const longtasks = await page.evaluate(
        () => (window as unknown as { __bench: { longtasks: number[] } }).__bench.longtasks,
      );
      m.scroll = {
        longTasks: longtasks.length,
        longTaskTotalMs: longtasks.reduce((a, b) => a + b, 0),
        longTaskMaxMs: longtasks.length ? Math.max(...longtasks) : 0,
        avgFps: fps.frames / (fps.ms / 1000),
        heapAfterScrollBytes: await heapBytes(page),
      };
    }
  } catch (err) {
    m.error = String(err).split("\n")[0];
  } finally {
    await context.close().catch(() => {});
  }
  return m;
}

// ---------------------------------------------------------------------------
// per-size / per-tool orchestration

interface ToolResult {
  tool: "prediff" | "difit";
  coldMs: number;
  warmOpenMs?: number; // prediff only (daemon reuse)
  api: Record<string, { ms: number; bytes: number; error?: string }>;
  browser?: {
    domContentLoadedMs: number; lcpMs: number; firstRenderMs: number;
    firstDiffLineMs: number; heapAfterRenderBytes: number;
    fullRenderMs?: number;
    scroll?: BrowserMetrics["scroll"];
    errors: string[];
  };
}

async function benchTool(
  which: "prediff" | "difit",
  repo: RepoInfo,
  browser: Browser | null,
): Promise<ToolResult> {
  const start = which === "prediff" ? startPrediff : startDifit;

  // cold starts (fresh state/process each time); keep the last one running
  const colds: number[] = [];
  let live: RunningTool | null = null;
  for (let i = 0; i < RUNS; i++) {
    const started = await start(repo.dir);
    colds.push(started.coldMs);
    if (i < RUNS - 1) await started.tool.stop();
    else live = started.tool;
  }
  const tool = live!;
  console.log(`    ${which}: cold start median ${fmtMs(median(colds))} (${colds.map((c) => c.toFixed(0)).join("/")})`);

  const result: ToolResult = { tool: which, coldMs: median(colds), api: {} };

  // prediff warm open (daemon already running, same state dir)
  if (which === "prediff" && tool.env) {
    const warms: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      await sh(tool.repo!, [BUN, PREDIFF_CLI, "open", "working", "--json"], tool.env);
      warms.push(performance.now() - t0);
    }
    result.warmOpenMs = median(warms);
    console.log(`    prediff: warm open median ${fmtMs(result.warmOpenMs)}`);
  }

  // API latency
  const apiTargets: Record<string, string> =
    which === "prediff"
      ? {
          "manifest (/api/diff)": new URL("/api/diff", tool.url).href,
          "largest file (/api/diff/file)": new URL(
            `/api/diff/file?path=${encodeURIComponent(repo.largestFile)}&force=1`,
            tool.url,
          ).href,
        }
      : { "full diff (/api/diff)": new URL("/api/diff", tool.url).href };

  for (const [label, url] of Object.entries(apiTargets)) {
    const runs: ApiResult[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await timedFetch(url));
    const ok = runs.filter((r) => !r.error);
    result.api[label] = {
      ms: median(ok.map((r) => r.ms)),
      bytes: ok[0]?.bytes ?? 0,
      error: ok.length ? undefined : runs[0]?.error,
    };
    console.log(`    ${which}: ${label} → ${fmtMs(result.api[label]!.ms)} (${fmtMB(result.api[label]!.bytes)})`);
  }

  // browser
  if (browser) {
    const fullAndScroll = repo.targetLines === SCROLL_SIZE;
    const runs: BrowserMetrics[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await browserRun(browser, tool, { fullAndScroll, fileCount: repo.fileCount });
      runs.push(r);
      console.log(
        `    ${which}: browser run ${i + 1}: firstDiffLine ${fmtMs(r.firstDiffLineMs)}` +
          (r.fullRenderMs ? `, fullRender ${fmtMs(r.fullRenderMs)}` : "") +
          (r.error ? ` [ERROR: ${r.error}]` : ""),
      );
    }
    const pick = (f: (r: BrowserMetrics) => number) => median(runs.map(f));
    const scrollRuns = runs.map((r) => r.scroll).filter((s): s is NonNullable<BrowserMetrics["scroll"]> => !!s);
    result.browser = {
      domContentLoadedMs: pick((r) => r.domContentLoadedMs),
      lcpMs: pick((r) => r.lcpMs),
      firstRenderMs: pick((r) => r.firstRenderMs),
      firstDiffLineMs: pick((r) => r.firstDiffLineMs),
      heapAfterRenderBytes: pick((r) => r.heapAfterRenderBytes),
      fullRenderMs:
        fullAndScroll && runs.some((r) => r.fullRenderMs !== undefined)
          ? pick((r) => r.fullRenderMs ?? NaN)
          : undefined,
      scroll: scrollRuns.length
        ? {
            longTasks: median(scrollRuns.map((s) => s.longTasks)),
            longTaskTotalMs: median(scrollRuns.map((s) => s.longTaskTotalMs)),
            longTaskMaxMs: median(scrollRuns.map((s) => s.longTaskMaxMs)),
            avgFps: median(scrollRuns.map((s) => s.avgFps)),
            heapAfterScrollBytes: median(scrollRuns.map((s) => s.heapAfterScrollBytes)),
          }
        : undefined,
      errors: runs.map((r) => r.error).filter((e): e is string => !!e),
    };
  }

  await tool.stop();
  return result;
}

// ---------------------------------------------------------------------------
// report

interface SizeResult { repo: RepoInfo; prediff: ToolResult; difit: ToolResult }

async function envInfo(): Promise<string> {
  const mac = (await sh(".", ["sw_vers", "-productVersion"]).catch(() => "?")).trim();
  const chip = (await sh(".", ["sysctl", "-n", "machdep.cpu.brand_string"]).catch(() => "?")).trim();
  const mem = Number((await sh(".", ["sysctl", "-n", "hw.memsize"]).catch(() => "0")).trim());
  const nodeV = (await sh(".", [NODE, "--version"]).catch(() => "?")).trim();
  const difitV = JSON.parse(
    await Bun.file(path.join(BENCH_DIR, "node_modules", "difit", "package.json")).text(),
  ).version;
  return [
    `- macOS ${mac}, ${chip}, ${(mem / 1024 ** 3).toFixed(0)} GB RAM`,
    `- bun ${Bun.version} (runs prediff from TS source), node ${nodeV} (runs difit from its published dist)`,
    `- difit ${difitV} (npm), prediff @ working tree`,
    `- Playwright headless Chromium (chromium-headless-shell), viewport 1440×900`,
  ].join("\n");
}

function toolTable(sizes: SizeResult[]): string {
  const rows: string[] = [];
  rows.push(
    "| Metric | " + sizes.map((s) => `~${s.repo.targetLines / 1000}k prediff | ~${s.repo.targetLines / 1000}k difit`).join(" | ") + " |",
  );
  rows.push("|---|" + sizes.map(() => "---|---").join("|") + "|");
  const line = (label: string, f: (t: ToolResult) => string) =>
    rows.push(`| ${label} | ` + sizes.map((s) => `${f(s.prediff)} | ${f(s.difit)}`).join(" | ") + " |");

  line("CLI → server ready (cold)", (t) => fmtMs(t.coldMs));
  line("CLI → URL (warm daemon)", (t) =>
    t.warmOpenMs !== undefined ? fmtMs(t.warmOpenMs) : "n/a (no daemon)",
  );
  line("API: diff data for first paint", (t) => {
    const k = t.tool === "prediff" ? "manifest (/api/diff)" : "full diff (/api/diff)";
    const a = t.api[k];
    return a?.error ? `error` : `${fmtMs(a!.ms)} (${fmtMB(a!.bytes)})`;
  });
  line("API: largest single file", (t) => {
    if (t.tool !== "prediff") return "n/a (single payload)";
    const a = t.api["largest file (/api/diff/file)"];
    return a ? `${fmtMs(a.ms)} (${fmtMB(a.bytes)})` : "n/a";
  });
  line("domContentLoaded", (t) => fmtMs(t.browser?.domContentLoadedMs ?? NaN));
  line("LCP", (t) => fmtMs(t.browser?.lcpMs ?? NaN));
  line("first render (file list)", (t) => fmtMs(t.browser?.firstRenderMs ?? NaN));
  line("first diff line visible", (t) => fmtMs(t.browser?.firstDiffLineMs ?? NaN));
  line("JS heap after render", (t) => fmtMB(t.browser?.heapAfterRenderBytes ?? NaN));
  return rows.join("\n");
}

function scrollTable(s: SizeResult): string {
  const rows = [
    "| Metric (10k diff, full render + scroll) | prediff | difit |",
    "|---|---|---|",
  ];
  const f = (t: ToolResult) => t.browser;
  rows.push(
    `| full diff rendered | ${f(s.prediff)?.fullRenderMs !== undefined ? fmtMs(f(s.prediff)!.fullRenderMs!) : "n/a (virtualized, renders on demand)"} | ${fmtMs(f(s.difit)?.fullRenderMs ?? NaN)} |`,
  );
  const sc = (t: ToolResult) => t.browser?.scroll;
  rows.push(`| long tasks during scroll (count) | ${sc(s.prediff)?.longTasks ?? "n/a"} | ${sc(s.difit)?.longTasks ?? "n/a"} |`);
  rows.push(`| long task total / max | ${sc(s.prediff) ? `${fmtMs(sc(s.prediff)!.longTaskTotalMs)} / ${fmtMs(sc(s.prediff)!.longTaskMaxMs)}` : "n/a"} | ${sc(s.difit) ? `${fmtMs(sc(s.difit)!.longTaskTotalMs)} / ${fmtMs(sc(s.difit)!.longTaskMaxMs)}` : "n/a"} |`);
  rows.push(`| avg FPS during scroll (rAF) | ${sc(s.prediff)?.avgFps.toFixed(0) ?? "n/a"} | ${sc(s.difit)?.avgFps.toFixed(0) ?? "n/a"} |`);
  rows.push(`| JS heap after scroll | ${fmtMB(sc(s.prediff)?.heapAfterScrollBytes ?? NaN)} | ${fmtMB(sc(s.difit)?.heapAfterScrollBytes ?? NaN)} |`);
  return rows.join("\n");
}

async function writeResults(sizes: SizeResult[], env: string): Promise<void> {
  const scrollSize = sizes.find((s) => s.repo.targetLines === SCROLL_SIZE);
  const errors = sizes.flatMap((s) =>
    [s.prediff, s.difit].flatMap((t) =>
      (t.browser?.errors ?? []).map((e) => `- ${t.tool} @ ~${s.repo.targetLines} lines: ${e}`),
    ),
  );
  const repoLines = sizes
    .map(
      (s) =>
        `- target ~${s.repo.targetLines}: actual +${s.repo.actualAdditions} −${s.repo.actualDeletions} across ${s.repo.fileCount} files`,
    )
    .join("\n");

  const md = `# prediff vs difit — large-diff benchmark

Generated by \`bun bench/compare.ts\` on ${new Date().toLocaleDateString("sv-SE")}.
All values are medians of ${RUNS} runs.

## Environment

${env}

## Methodology

- Synthetic git repos with a deterministic, realistic-ish spread: ~60% of
  changed lines are in-place modifications across many files of varying sizes
  and languages (.ts/.tsx/.py/.go/.md/.json), ~30% new files (registered with
  \`git add -N\` so both tools see them in a working-tree diff), ~10% deleted
  files. Actual diff sizes (from \`git diff --numstat HEAD\`):
${repoLines}
- **Cold start**: time from CLI invocation to the URL/ready line being
  printed. prediff: \`prediff open working --json\` with a fresh state dir
  (spawns the daemon, computes the diff, prints JSON, exits). difit:
  \`difit working --no-open --keep-alive --port N\` until its
  "server started on" line appears. Fresh state/process each run.
- **API latency**: \`GET\` timed with \`fetch\` from the harness.
  prediff serves a two-phase API (manifest, then per-file hunks on demand);
  difit serves the entire parsed diff as one \`/api/diff\` payload — the rows
  compare "the request(s) the UI needs before first paint".
- **Browser**: Playwright headless Chromium, fresh context per run.
  domContentLoaded from the Navigation Timing API; LCP from a buffered
  PerformanceObserver; "first render" = file list/shell visible;
  "first diff line visible" = first added/removed line of code in the DOM.
  prediff collapses files by default, so its number includes a scripted click
  on the first file — the real user path. JS heap via CDP
  \`Performance.getMetrics\` (JSHeapUsedSize) after a 1.2 s settle.
- **Scroll (10k only)**: difit renders the whole diff up front, so its "full
  diff rendered" equals first render; prediff's virtualized UI never has an
  "everything in the DOM" state (n/a by design). Then both tools get the same
  scripted walk: 40 × 2000 px wheel steps at 60 ms intervals — for prediff the
  script also clicks collapsed files open as they come into view, like a
  reviewer walking a large diff. Long tasks from a buffered \`longtask\`
  PerformanceObserver, FPS as rAF callbacks / elapsed time.

## Results

${toolTable(sizes)}

${scrollSize ? `### Scrolling & full render (10k diff)\n\n${scrollTable(scrollSize)}` : ""}

${errors.length ? `### Errors / timeouts observed\n\n${errors.join("\n")}` : ""}

## Findings (analysis of the 2026-07-18 run; verify against tables above after re-runs)

- **prediff's browser metrics are flat across diff size** (first render ~50–60 ms,
  first diff line ~160 ms, heap ~4–5 MB at 1k, 10k and 50k) because the UI only
  ever fetches a small manifest and renders the visible viewport. difit's grow
  with the diff (first diff line 342 ms → 791 ms → 1.7 s; heap 13 → 49 → 60 MB)
  because it ships and renders the entire diff up front.
- **difit did not break at 50k** — no hang, no crash — it is just ~10× slower
  to first diff line and holds >10× the JS heap. Its heap also grows while
  scrolling (49 MB after render → ~170 MB after a 80k px scroll at 10k),
  consistent with highlight-on-scroll allocations; prediff stays ~11 MB.
- **Scrolling**: prediff produced 0 long tasks and held the rAF cap (~120/s in
  headless); difit showed a couple of 100–190 ms long tasks and ~70 rAF/s on
  the same scripted walk.
- **Server side, both are fast**: difit's single \`/api/diff\` payload is
  7.8 MB at 50k but still serves in ~25 ms on localhost; the payload size is a
  browser-parse/render problem, not a network one. prediff's per-file endpoint
  is ~13 ms per request (a git subprocess each call).
- **ARCHITECTURE.md performance targets**: open→URL 304 ms cold / 158 ms warm
  at 50k (targets 1.5 s / 300 ms) — met; 10k first contentful render ~170 ms
  (target 1 s) — met; 50k tab memory ~4.5 MB after render (target < 500 MB) —
  met, though 60 fps scroll at 50k was not directly measured (scroll test runs
  at 10k).
- **prediff fix items spotted while benchmarking**:
  1. Warm \`open\` grows with diff size (89 → 105 → 158 ms): \`/api/open\`
     recomputes the whole manifest even when nothing changed since the last
     generation; it could reuse the watcher's signature check.
  2. \`/api/diff/file\` shells out to git on every request (~13 ms each) with
     no per-generation cache; collapsing/re-expanding a file re-pays it.
  3. The 1 s repo watcher poll spawns \`git status\` + \`rev-parse\` plus one
     \`stat\` per dirty file every second — 138 dirty files means constant
     background churn on large working trees.

## Caveats

- prediff runs from TypeScript source under bun; difit runs its published,
  pre-built npm dist under node. That is how each ships today, but it is not
  an engine-identical comparison.
- prediff's frontend (React + @tanstack/react-virtual, Shiki highlighting in a
  worker, files collapsed by default, hunks fetched on expand) is under active
  development and was measured as of this working tree; difit ships its
  released React UI (Prism highlighting, whole diff rendered up front). The
  browser rows compare the two architectures — lazy two-phase + virtualization
  vs render-everything. "First diff line" for prediff includes a scripted
  click to open the first file.
- difit was started with \`--keep-alive\` so the server survives Playwright
  context teardown between runs; this does not affect the measured paths.
- FPS is approximated by requestAnimationFrame frequency in a headless
  browser; treat it as a relative signal, not a display-accurate frame rate.
- Both tools measured on the same machine, sequentially; no other load.
`;
  await fs.writeFile(OUT, md);
  console.log(`\nwrote ${OUT}`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`sizes: ${SIZES.join(", ")} changed lines; ${RUNS} runs each; browser: ${!SKIP_BROWSER}`);
  const browser = SKIP_BROWSER ? null : await chromium.launch();
  const results: SizeResult[] = [];
  const repos: string[] = [];
  try {
    for (const size of SIZES) {
      console.log(`\n== ~${size} changed lines ==`);
      const repo = await generateRepo(size);
      repos.push(repo.dir);
      console.log(
        `  repo: ${repo.fileCount} files, +${repo.actualAdditions} -${repo.actualDeletions} (${repo.dir})`,
      );
      const prediff = await benchTool("prediff", repo, browser);
      const difit = await benchTool("difit", repo, browser);
      results.push({ repo, prediff, difit });
    }
    await fs.writeFile(
      path.join(BENCH_DIR, "results.json"),
      JSON.stringify(results, (_k, v) => (Number.isNaN(v) ? null : v), 2),
    );
    await writeResults(results, await envInfo());
    console.log("\n" + toolTable(results));
  } finally {
    await browser?.close().catch(() => {});
    if (!KEEP) for (const r of repos) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
    else console.log(`kept repos:\n${repos.join("\n")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
