/** Daemon lockfile: port + pid under the state dir; stale locks are replaced. */

import fs from "node:fs/promises";
import type { Lockfile } from "../types";
import { readJson, writeJsonAtomic } from "../store/atomic";
import { lockfilePath } from "../store/paths";

export async function readLockfile(stateDir: string): Promise<Lockfile | null> {
  return readJson<Lockfile>(lockfilePath(stateDir));
}

export async function writeLockfile(stateDir: string, lock: Lockfile): Promise<void> {
  await writeJsonAtomic(lockfilePath(stateDir), lock);
}

export async function removeLockfile(stateDir: string): Promise<void> {
  await fs.rm(lockfilePath(stateDir), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the lockfile if it points at a live, responding daemon;
 * removes it and returns null otherwise.
 */
export async function liveLockfile(stateDir: string): Promise<Lockfile | null> {
  const lock = await readLockfile(stateDir);
  if (!lock) return null;
  if (pidAlive(lock.pid) && (await healthy(lock.url))) return lock;
  await removeLockfile(stateDir);
  return null;
}

export async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/health", url), {
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
