/** CLI-side daemon discovery, detached spawn, and HTTP client. */

import fs from "node:fs/promises";
import path from "node:path";
import type { Lockfile, Session } from "../types";
import { repoRoot as gitRepoRoot } from "../git/exec";
import { daemonLogPath, dataHome, sessionPath, stateDir } from "../store/paths";
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

/** Git root when available; otherwise the real current directory. */
export async function workspaceRoot(cwd = process.cwd()): Promise<string> {
  return (await gitRepoRoot(cwd)) ?? fs.realpath(cwd);
}

/** Lockfile of a live daemon for this workspace, or null. */
export async function findDaemon(repoRoot: string): Promise<Lockfile | null> {
  return liveLockfile(await stateDir(repoRoot));
}

export interface EnsureOptions {
  range: string;
  ttlS?: number;
  initialPatch?: string;
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
  let bootstrapPatch: string | null = null;
  if (opts.initialPatch !== undefined) {
    bootstrapPatch = path.join(dir, "bootstrap.patch");
    await Bun.write(bootstrapPatch, opts.initialPatch);
  }
  const args = [
    process.execPath, // the bun binary running this CLI
    DAEMON_ENTRY,
    "--repo",
    repoRoot,
    "--range",
    opts.range,
    "--ttl",
    String(opts.ttlS ?? DEFAULT_TTL_S),
    ...(bootstrapPatch !== null ? ["--patch-file", bootstrapPatch] : []),
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

/** Find the state directory and live daemon that own an explicit session. */
export async function findDaemonForSession(
  sessionId: string,
): Promise<{ lock: Lockfile; session: Session } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dataHome());
  } catch {
    return null;
  }
  for (const entry of entries) {
    const dir = path.join(dataHome(), entry);
    const file = Bun.file(sessionPath(dir, sessionId));
    if (!(await file.exists())) continue;
    let session: Session;
    try {
      session = (await file.json()) as Session;
    } catch {
      continue;
    }
    const lock = await liveLockfile(dir);
    if (lock) return { lock, session };
  }
  return null;
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
