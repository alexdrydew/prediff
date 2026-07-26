/** Atomic persistence for the latest normalized diff of patch-backed sessions. */

import fs from "node:fs/promises";
import path from "node:path";
import { patchSourcePath } from "./paths";

export async function savePatchSource(
  stateDir: string,
  sessionId: string,
  patch: string,
): Promise<void> {
  const file = patchSourcePath(stateDir, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, patch);
  await fs.rename(tmp, file);
}

export async function loadPatchSource(
  stateDir: string,
  sessionId: string,
): Promise<string | null> {
  const file = Bun.file(patchSourcePath(stateDir, sessionId));
  return (await file.exists()) ? file.text() : null;
}
