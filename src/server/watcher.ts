/**
 * Repo watcher: polls `git status --porcelain` + HEAD at a low rate; when the
 * signature changes it fires the callback (debounced), used to auto-refresh
 * working/staged diffs.
 *
 * Porcelain output alone misses repeat edits to an already-dirty file (the
 * "XY path" line doesn't change), so the signature also folds in mtime+size
 * of every dirty path.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { git } from "../git/exec";

const POLL_MS = 1_000;
const DEBOUNCE_MS = 250;

export class RepoWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSignature: string | null = null;
  private checking = false;

  constructor(
    private readonly repo: string,
    private readonly onChange: () => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), POLL_MS);
    // Don't keep the process alive just for the watcher.
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.timer = null;
    this.debounceTimer = null;
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const [status, head] = await Promise.all([
        git(this.repo, ["status", "--porcelain", "-z"], { allowFail: true }),
        git(this.repo, ["rev-parse", "HEAD"], { allowFail: true }),
      ]);
      const stats = await this.statDirtyPaths(status.stdout);
      const signature = `${head.stdout.trim()}\n${status.stdout}\n${stats}`;
      const changed = this.lastSignature !== null && signature !== this.lastSignature;
      this.lastSignature = signature;
      if (changed) this.fire();
    } finally {
      this.checking = false;
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
