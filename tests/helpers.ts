/** Test helpers: temp git repos and temp state dirs. */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `prediff-${prefix}-`));
}

export async function sh(cwd: string, cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err}`);
  return out;
}

export async function initRepo(): Promise<string> {
  const dir = await tempDir("repo");
  await sh(dir, ["git", "init", "-q", "-b", "main"]);
  await sh(dir, ["git", "config", "user.email", "test@prediff.local"]);
  await sh(dir, ["git", "config", "user.name", "prediff tests"]);
  await sh(dir, ["git", "config", "commit.gpgsign", "false"]);
  return dir;
}

export async function write(repo: string, file: string, content: string | Uint8Array): Promise<void> {
  const p = path.join(repo, file);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await Bun.write(p, content);
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await sh(repo, ["git", "add", "-A"]);
  await sh(repo, ["git", "commit", "-q", "-m", message]);
}

export async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
}

export const BUN = process.execPath;
