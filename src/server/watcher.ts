/**
 * Repo watcher: fires a callback (debounced) when the repo's change signature
 * — `git status --porcelain` + HEAD + mtime+size of every dirty path — changes.
 * Used to auto-refresh working/staged diffs.
 *
 * Porcelain output alone misses repeat edits to an already-dirty file (the
 * "XY path" line doesn't change), so the signature also folds in mtime+size
 * of every dirty path. Untracked files count as dirty: they're listed
 * individually (--untracked-files=all) so creating, editing, or deleting one
 * — even inside an untracked directory — changes the signature.
 *
 * The signature is the authoritative change detector; fs events only decide
 * WHEN to compute it. `fs.watch` on the repo root (recursive, which covers
 * .git) triggers a check after a short settle window, with a slow poll as a
 * safety net for missed events. Where recursive fs.watch is unavailable, the
 * watcher degrades to the original fast poll.
 */

import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { git } from "../git/exec";

/** Fallback poll rate when fs events are unavailable (original behavior). */
const FAST_POLL_MS = 1_000;
/** Safety-net poll rate when fs events are active. */
const SAFETY_POLL_MS = 7_000;
/** Coalesce bursts of fs events before running the (subprocess) check. */
const EVENT_SETTLE_MS = 100;
const DEBOUNCE_MS = 250;

export class RepoWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private fsWatcher: FSWatcher | null = null;
  private lastSignature: string | null = null;
  private checking = false;
  private recheck = false;

  constructor(
    private readonly repo: string,
    private readonly onChange: () => void,
  ) {}

  start(): void {
    if (this.timer || this.fsWatcher) return;
    let pollMs = FAST_POLL_MS;
    try {
      this.fsWatcher = watch(this.repo, { recursive: true }, () => this.scheduleCheck());
      this.fsWatcher.on("error", () => this.degradeToPolling());
      this.fsWatcher.unref();
      pollMs = SAFETY_POLL_MS;
    } catch {
      this.fsWatcher = null; // recursive watch unavailable; poll instead
    }
    this.startPoll(pollMs);
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.fsWatcher?.close();
    this.timer = null;
    this.debounceTimer = null;
    this.eventTimer = null;
    this.fsWatcher = null;
  }

  /**
   * Current repo change signature. Stateless with respect to the watcher's
   * own change tracking, so callers (e.g. warm `open`) can compare it against
   * the signature a diff manifest was computed at.
   */
  async computeSignature(): Promise<string> {
    const [status, head] = await Promise.all([
      // --no-optional-locks: never write .git/index from a background check
      // (avoids feeding our own fs events back into the watcher).
      // --untracked-files=all: list files inside untracked directories
      // individually — plain porcelain collapses them to "?? dir/", whose
      // stat doesn't change when a contained file is edited in place.
      git(
        this.repo,
        ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "-z"],
        { allowFail: true },
      ),
      git(this.repo, ["rev-parse", "HEAD"], { allowFail: true }),
    ]);
    const stats = await this.statDirtyPaths(status.stdout);
    return `${head.stdout.trim()}\n${status.stdout}\n${stats}`;
  }

  private startPoll(pollMs: number): void {
    this.timer = setInterval(() => void this.check(), pollMs);
    // Don't keep the process alive just for the watcher.
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  /** fs.watch failed at runtime: fall back to the original fast poll. */
  private degradeToPolling(): void {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.timer) clearInterval(this.timer);
    this.startPoll(FAST_POLL_MS);
  }

  /** Run a check shortly after fs activity, coalescing event bursts. */
  private scheduleCheck(): void {
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      void this.check();
    }, EVENT_SETTLE_MS);
    this.eventTimer.unref?.();
  }

  private async check(): Promise<void> {
    if (this.checking) {
      // An event arrived mid-check; re-check once done so it isn't lost.
      this.recheck = true;
      return;
    }
    this.checking = true;
    try {
      const signature = await this.computeSignature();
      const changed = this.lastSignature !== null && signature !== this.lastSignature;
      this.lastSignature = signature;
      if (changed) this.fire();
    } finally {
      this.checking = false;
      if (this.recheck) {
        this.recheck = false;
        this.scheduleCheck();
      }
    }
  }

  /** mtime+size of every path mentioned in `git status --porcelain -z`. */
  private async statDirtyPaths(porcelainZ: string): Promise<string> {
    const tokens = porcelainZ.split("\0").filter((t) => t.length > 0);
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.length > 3 && t[2] === " ") {
        paths.push(t.slice(3));
        // Renames/copies carry the source path as an extra NUL token.
        if (t[0] === "R" || t[0] === "C" || t[1] === "R" || t[1] === "C") {
          const src = tokens[++i];
          if (src) paths.push(src);
        }
      } else {
        paths.push(t);
      }
    }
    const parts = await Promise.all(
      paths.map(async (p) => {
        try {
          const st = await fs.stat(path.join(this.repo, p));
          return `${p}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${p}:gone`;
        }
      }),
    );
    return parts.join("\n");
  }

  private fire(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChange();
    }, DEBOUNCE_MS);
  }
}
