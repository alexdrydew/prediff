/**
 * Revision history: one gzipped JSON snapshot per revision (manifest + raw
 * diff text) under <stateDir>/revisions/<session-id>/<N>.json.gz, so older
 * revisions stay viewable after the diff moves on (spec §0.1, §9.2).
 * History is bounded: only the most recent HISTORY_MAX revisions are kept.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { RevisionSnapshot } from "../types";
import { revisionPath, revisionsDir } from "./paths";

export const HISTORY_MAX = 50;

export class RevisionStore {
  constructor(readonly stateDir: string) {}

  async save(sessionId: string, snapshot: RevisionSnapshot): Promise<void> {
    const file = revisionPath(this.stateDir, sessionId, snapshot.revision);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const gz = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(snapshot)));
    // Atomic: write temp then rename, same guarantee as session files.
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await Bun.write(tmp, gz);
    await fs.rename(tmp, file);
    await this.prune(sessionId, snapshot.revision);
  }

  async load(sessionId: string, revision: number): Promise<RevisionSnapshot | null> {
    const file = Bun.file(revisionPath(this.stateDir, sessionId, revision));
    if (!(await file.exists())) return null;
    try {
      const gz = new Uint8Array(await file.arrayBuffer());
      return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz))) as RevisionSnapshot;
    } catch {
      return null; // corrupt snapshot: treat as absent
    }
  }

  async exists(sessionId: string, revision: number): Promise<boolean> {
    return Bun.file(revisionPath(this.stateDir, sessionId, revision)).exists();
  }

  /** Revision numbers on disk, ascending. */
  async list(sessionId: string): Promise<number[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(revisionsDir(this.stateDir, sessionId));
    } catch {
      return [];
    }
    return entries
      .map((name) => /^(\d+)\.json\.gz$/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  private async prune(sessionId: string, latest: number): Promise<void> {
    const revisions = await this.list(sessionId);
    const cutoff = latest - HISTORY_MAX;
    await Promise.all(
      revisions
        .filter((n) => n <= cutoff)
        .map((n) => fs.rm(revisionPath(this.stateDir, sessionId, n), { force: true })),
    );
  }
}
