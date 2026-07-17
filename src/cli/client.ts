/** CLI-side daemon discovery, detached spawn, and HTTP client. */

import fs from "node:fs/promises";
import path from "node:path";
import type { Lockfile } from "../types";
import { repoRoot as gitRepoRoot } from "../git/exec";
import { daemonLogPath, stateDir } from "../store/paths";
import { liveLockfile } from "../server/lockfile";
import { DEFAULT_TTL_S } from "../server/daemon";

const DAEMON_ENTRY = path.join(import.meta.dir, "..", "server", "daemon.ts");
const SPAWN_WAIT_MS = 10_000;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export async function requireRepoRoot(cwd = process.cwd()): Promise<string> {
  const root = await gitRepoRoot(cwd);
  if (!root) throw new CliError("not inside a git repository");
  return root;
}

/** Lockfile of a live daemon for this repo, or null. */
export async function findDaemon(repoRoot: string): Promise<Lockfile | null> {
  return liveLockfile(await stateDir(repoRoot));
}

export interface EnsureOptions {
  range: string;
  ttlS?: number;
}

/**
 * Reuse a live daemon or spawn a new detached one; resolves once it responds.
 * The daemon is spawned with stdio detached to a log file so it outlives us.
 */
export async function ensureDaemon(repoRoot: string, opts: EnsureOptions): Promise<Lockfile> {
  const existing = await findDaemon(repoRoot);
  if (existing) return existing;

  const dir = await stateDir(repoRoot);
  const logFile = Bun.file(daemonLogPath(dir));
  const args = [
    process.execPath, // the bun binary running this CLI
    DAEMON_ENTRY,
    "--repo",
    repoRoot,
    "--range",
    opts.range,
    "--ttl",
    String(opts.ttlS ?? DEFAULT_TTL_S),
  ];
  const child = Bun.spawn(args, {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: logFile,
    stderr: logFile,
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new CliError(
        `daemon exited with code ${child.exitCode}; see ${daemonLogPath(dir)}`,
      );
    }
    const lock = await liveLockfile(dir);
    if (lock && lock.pid === child.pid) return lock;
    await Bun.sleep(50);
  }
  throw new CliError(`daemon did not become ready; see ${daemonLogPath(dir)}`);
}

export async function api<T>(
  lock: Lockfile,
  route: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(new URL(route, lock.url), {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs ?? 10_000),
      headers: { "content-type": "application/json", ...(rest.headers ?? {}) },
    });
  } catch (err) {
    throw new CliError(`cannot reach prediff daemon at ${lock.url}: ${String(err)}`);
  }
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new CliError(body.error ?? `daemon returned HTTP ${res.status}`);
  return body;
}

/** Remove a stale lockfile (used by `stop` after killing a wedged daemon). */
export async function clearLock(repoRoot: string): Promise<void> {
  const dir = await stateDir(repoRoot);
  await fs.rm(path.join(dir, "daemon.json"), { force: true });
}
