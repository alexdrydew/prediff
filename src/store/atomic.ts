/** Atomic JSON file writes: write temp file in the same dir, then rename. */

import fs from "node:fs/promises";
import path from "node:path";

let seq = 0;

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${++seq}-${Date.now()}`,
  );
  await Bun.write(tmp, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(tmp, filePath);
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  const f = Bun.file(filePath);
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as T;
  } catch {
    return null; // corrupt/partial file: treat as absent, never crash
  }
}
