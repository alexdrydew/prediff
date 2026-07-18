/** State-directory layout: ~/.local/share/prediff/<repo-id>/ */

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

/** repo-id = first 12 hex chars of sha256(realpath of repo root). */
export async function repoId(repoRoot: string): Promise<string> {
  const real = await fs.realpath(repoRoot);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(real);
  return hasher.digest("hex").slice(0, 12);
}

export function dataHome(): string {
  const override = process.env["PREDIFF_STATE_DIR"];
  if (override) return override;
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg) return path.join(xdg, "prediff");
  return path.join(os.homedir(), ".local", "share", "prediff");
}

export async function stateDir(repoRoot: string): Promise<string> {
  const dir = path.join(dataHome(), await repoId(repoRoot));
  await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

export function sessionPath(stateDir_: string, sessionId: string): string {
  return path.join(stateDir_, "sessions", `${sessionId}.json`);
}

export function currentSessionPath(stateDir_: string): string {
  return path.join(stateDir_, "current.json");
}

/** Per-session revision snapshots: <stateDir>/revisions/<session-id>/<N>.json.gz */
export function revisionsDir(stateDir_: string, sessionId: string): string {
  return path.join(stateDir_, "revisions", sessionId);
}

export function revisionPath(stateDir_: string, sessionId: string, revision: number): string {
  return path.join(revisionsDir(stateDir_, sessionId), `${revision}.json.gz`);
}

export function lockfilePath(stateDir_: string): string {
  return path.join(stateDir_, "daemon.json");
}

export function daemonLogPath(stateDir_: string): string {
  return path.join(stateDir_, "daemon.log");
}
