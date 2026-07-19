/**
 * Revision history: one gzipped JSON snapshot per revision (manifest + raw
 * diff text) under <stateDir>/revisions/<session-id>/<N>.json.gz, so older
 * revisions stay viewable after the diff moves on (spec §0.1, §9.2).
 * Alongside each snapshot, <N>.files.json.gz stores the new-side content of
 * every (non-binary, non-large) changed file — the raw material for
 * line-level interdiffs between revisions (QA gap §1.4).
 * History is bounded: only the most recent HISTORY_MAX revisions are kept.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { RevisionContents, RevisionSnapshot } from "../types";
import { revisionContentsPath, revisionPath, revisionsDir } from "./paths";

export const HISTORY_MAX = 50;

export class RevisionStore {
  constructor(readonly stateDir: string) {}

  async save(sessionId: string, snapshot: RevisionSnapshot): Promise<void> {
    await this.writeGz(revisionPath(this.stateDir, sessionId, snapshot.revision), snapshot);
    await this.prune(sessionId, snapshot.revision);
  }

  async load(sessionId: string, revision: number): Promise<RevisionSnapshot | null> {
    return this.readGz<RevisionSnapshot>(revisionPath(this.stateDir, sessionId, revision));
  }

  async exists(sessionId: string, revision: number): Promise<boolean> {
    return Bun.file(revisionPath(this.stateDir, sessionId, revision)).exists();
  }

  async saveContents(sessionId: string, contents: RevisionContents): Promise<void> {
    await this.writeGz(
      revisionContentsPath(this.stateDir, sessionId, contents.revision),
      contents,
    );
  }

  async loadContents(sessionId: string, revision: number): Promise<RevisionContents | null> {
    return this.readGz<RevisionContents>(
      revisionContentsPath(this.stateDir, sessionId, revision),
    );
  }

  async hasContents(sessionId: string, revision: number): Promise<boolean> {
    return Bun.file(revisionContentsPath(this.stateDir, sessionId, revision)).exists();
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

  private async writeGz(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const gz = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(value)));
    // Atomic: write temp then rename, same guarantee as session files.
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await Bun.write(tmp, gz);
    await fs.rename(tmp, file);
  }

  private async readGz<T>(file: string): Promise<T | null> {
    const f = Bun.file(file);
    if (!(await f.exists())) return null;
    try {
      const gz = new Uint8Array(await f.arrayBuffer());
      return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz))) as T;
    } catch {
      return null; // corrupt file: treat as absent
    }
  }

  private async prune(sessionId: string, latest: number): Promise<void> {
    const revisions = await this.list(sessionId);
    const cutoff = latest - HISTORY_MAX;
    await Promise.all(
      revisions
        .filter((n) => n <= cutoff)
        .flatMap((n) => [
          fs.rm(revisionPath(this.stateDir, sessionId, n), { force: true }),
          fs.rm(revisionContentsPath(this.stateDir, sessionId, n), { force: true }),
        ]),
    );
  }
}
