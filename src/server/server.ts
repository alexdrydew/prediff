/**
 * Per-repo daemon: Bun.serve JSON API + SSE + static UI + repo watcher +
 * idle-TTL self-shutdown. See ARCHITECTURE.md §2 and §4; review-model
 * semantics per design/prediff-interaction-spec.md.
 */

import path from "node:path";
import type {
  CommentAnchor,
  CommentTag,
  DiffManifest,
  FeedbackBatch,
  FileContentResult,
  FileDiff,
  InterdiffFile,
  InterdiffFileSummary,
  InterdiffManifest,
  ManifestFile,
  MarkReadyResult,
  OpenResult,
  ReviewComment,
  RevisionContents,
  RevisionSnapshot,
  RevisionsResult,
  Session,
  Side,
  StatusResult,
  WaitReason,
  WaitResult,
} from "../types";
import {
  computeFileDiff,
  computeManifest,
  computeRawDiff,
  diffLinesNoIndex,
  mapLimit,
  parseUnifiedDiff,
  resolveRange,
  sideContent,
  splitFileSections,
  type ResolvedRange,
} from "../git/diff";
import { anchorWindowIntact, buildAnchor, reanchorOutcome } from "../store/anchor";
import { changedLinesText, computeScopeFlags } from "../scope";
import {
  SessionStore,
  addComment,
  addReply,
  commentCounts,
  deleteComment,
  findComment,
  resolveComment,
  setViewed,
  submitComments,
  type NewCommentInput,
} from "../store/session";
import { RevisionStore } from "../store/revisions";
import { EventHub } from "./events";
import { RepoWatcher } from "./watcher";
import {
  readPreferredPort,
  removeLockfile,
  writeLockfile,
  writePreferredPort,
} from "./lockfile";

export interface DaemonOptions {
  repoRoot: string;
  stateDir: string;
  range: string;
  /** Idle TTL in milliseconds; 0 disables self-shutdown. */
  ttlMs: number;
  port?: number;
}

const PUBLIC_DIR = path.join(import.meta.dir, "..", "..", "public");
const UI_PATH = path.join(PUBLIC_DIR, "index.html");
const TTL_CHECK_MS = 60_000;
/** Max entries in the per-revision file-diff LRU cache. */
const FILE_DIFF_CACHE_MAX = 256;

const COMMENT_TAGS: ReadonlySet<string> = new Set(["must-fix", "suggestion", "question", "nit"]);
const COMMENT_STATES: ReadonlySet<string> = new Set([
  "draft",
  "submitted",
  "addressed",
  "resolved",
  "orphaned",
]);

interface JsonBody {
  [key: string]: unknown;
}

export class Daemon {
  private readonly store: SessionStore;
  private readonly revisions: RevisionStore;
  private readonly hub = new EventHub();
  private session!: Session;
  private range!: ResolvedRange;
  private manifest!: DiffManifest;
  /** Raw diff text of the current revision (also persisted, gzipped). */
  private rawDiff = "";
  private watcher: RepoWatcher;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private lastActivity = Date.now();
  private ttlTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<boolean> | null = null;
  /** Repo change-signature the current manifest was computed at (see openSession). */
  private manifestSignature: string | null = null;
  /**
   * Per-revision LRU cache for /api/diff/file responses (current revision
   * only), keyed by path + force flag. Cleared on every revision bump or
   * session/range change.
   */
  private readonly fileDiffCache = new Map<string, FileDiff>();
  /** Diagnostic counters (exposed on /api/health, used by tests). */
  private readonly stats = {
    manifest_computes: 0,
    file_diff_computes: 0,
    file_diff_cache_hits: 0,
  };

  constructor(private readonly opts: DaemonOptions) {
    this.store = new SessionStore(opts.stateDir);
    this.revisions = new RevisionStore(opts.stateDir);
    this.watcher = new RepoWatcher(opts.repoRoot, () => {
      if (this.range.targetRef === null || this.range.targetRef === ":index") {
        void this.refresh();
      }
    });
  }

  get url(): string {
    if (!this.server) throw new Error("daemon not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  async start(): Promise<void> {
    await this.openSession(this.opts.range, null);

    this.server = await this.bind();
    await writePreferredPort(this.opts.stateDir, this.server.port ?? 0);

    await writeLockfile(this.opts.stateDir, {
      pid: process.pid,
      port: this.server.port ?? 0,
      url: this.url,
      repo_root: this.opts.repoRoot,
      started_at: new Date().toISOString(),
    });

    this.watcher.start();

    if (this.opts.ttlMs > 0) {
      this.ttlTimer = setInterval(() => {
        if (Date.now() - this.lastActivity > this.opts.ttlMs) {
          void this.shutdown("idle ttl reached");
        }
      }, TTL_CHECK_MS);
      this.ttlTimer.unref();
    }

    const cleanup = () => void this.shutdown("signal");
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGHUP", () => {
      /* survive terminal close */
    });
  }

  /**
   * Bind the HTTP server. Preference order (QA F1 — restarts must not strand
   * open browser tabs): an explicit `port` option (errors are fatal), else
   * the port persisted from the previous run (falling back to a random port
   * if it's taken), else a random port. The bound port is persisted by
   * `start()` so the next daemon for this repo rebinds it.
   */
  private async bind(): Promise<ReturnType<typeof Bun.serve>> {
    const serve = (port: number) =>
      Bun.serve({
        port,
        hostname: "127.0.0.1",
        idleTimeout: 0, // long-polls and SSE must not be cut off
        fetch: (req) => this.route(req),
      });

    if (this.opts.port !== undefined) return serve(this.opts.port);
    const preferred = await readPreferredPort(this.opts.stateDir);
    if (preferred !== null) {
      try {
        return serve(preferred);
      } catch {
        // Port taken (or otherwise unbindable): fall back to a random port.
        // start() persists the new one, so future restarts stay stable again.
      }
    }
    return serve(0);
  }

  /** Release resources without exiting the process (used by in-process tests). */
  async close(): Promise<void> {
    this.watcher.stop();
    if (this.ttlTimer) clearInterval(this.ttlTimer);
    await removeLockfile(this.opts.stateDir);
    this.server?.stop(true);
    this.server = null;
  }

  async shutdown(reason: string): Promise<never> {
    console.log(`[prediff] shutting down: ${reason}`);
    await this.close();
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Session / diff lifecycle

  /** Create or reuse the current session for `rangeSpec`, then refresh. */
  private async openSession(
    rangeSpec: string,
    scope: string | null,
    scopeFiles: string[] | null = null,
  ): Promise<void> {
    // Capture the change signature BEFORE computing the manifest: anything
    // that changes afterwards is guaranteed to produce a mismatch later.
    const signature = await this.watcher.computeSignature();
    this.range = await resolveRange(this.opts.repoRoot, rangeSpec);
    const existing = await this.store.loadCurrent();
    if (existing && existing.range === rangeSpec) {
      this.session = existing;
      if (this.applyScope(scope, scopeFiles)) await this.store.save(this.session);
    } else {
      this.session = await this.store.create(this.opts.repoRoot, rangeSpec, scope, scopeFiles);
      this.hub.broadcast("session.changed", { session_id: this.session.session_id });
    }
    this.stats.manifest_computes++;
    [this.manifest, this.rawDiff] = await Promise.all([
      computeManifest(this.opts.repoRoot, this.range, this.session.revision),
      computeRawDiff(this.opts.repoRoot, this.range),
    ]);
    this.manifestSignature = signature;
    this.applyScopeFlags();
    this.fileDiffCache.clear();
    await this.persistRevision();
  }

  /**
   * Annotate the current manifest with out-of-scope flags (QA §1.2). Runs
   * server-side because the heuristic is content-aware: it needs each file's
   * diff text, which the client doesn't have for collapsed files.
   */
  private applyScopeFlags(): void {
    const sections = splitFileSections(this.rawDiff);
    const flags = computeScopeFlags(
      this.manifest.files.map((f) => ({
        path: f.path,
        diff_text: changedLinesText(sections.get(f.path)),
      })),
      this.session.scope,
      this.session.scope_files,
    );
    for (const f of this.manifest.files) {
      const reason = flags.get(f.path);
      if (reason !== undefined) f.scope_flag = { flagged: true, reason };
      else delete f.scope_flag;
    }
  }

  /** Apply new scope/scope-files values (null = leave unchanged). Returns
   * whether anything changed; the caller persists. */
  private applyScope(scope: string | null, scopeFiles: string[] | null): boolean {
    let changed = false;
    if (scope !== null && scope !== this.session.scope) {
      this.session.scope = scope;
      changed = true;
    }
    if (
      scopeFiles !== null &&
      JSON.stringify(scopeFiles) !== JSON.stringify(this.session.scope_files)
    ) {
      this.session.scope_files = scopeFiles;
      changed = true;
    }
    return changed;
  }

  /**
   * Persist the current revision's snapshot. If a snapshot for this number
   * already exists but the diff has drifted (daemon restarted after edits,
   * before any refresh bumped the number), overwrite it so history always
   * matches what /api/diff reports for that revision.
   */
  private async persistRevision(): Promise<void> {
    const sessionId = this.session.session_id;
    const revision = this.session.revision;
    const existing = await this.revisions.load(sessionId, revision);
    const unchanged = existing !== null && existing.raw_diff === this.rawDiff;
    if (!unchanged) {
      await this.revisions.save(sessionId, {
        revision,
        created_at: new Date().toISOString(),
        manifest: this.manifest,
        raw_diff: this.rawDiff,
      });
    }
    // New-side contents power interdiffs (§1.4); also backfill them for a
    // snapshot written before interdiff support existed.
    if (!unchanged || !(await this.revisions.hasContents(sessionId, revision))) {
      await this.revisions.saveContents(sessionId, await this.captureContents(revision));
    }
  }

  /**
   * New-side content of every changed file in the current manifest — the raw
   * material for interdiffs between revisions. Respects the existing
   * large-file threshold: binary/large files are recorded as skipped and
   * their interdiff is reported "not available".
   */
  private async captureContents(revision: number): Promise<RevisionContents> {
    const files: Record<string, string[] | null> = {};
    const skipped: Record<string, string> = {};
    for (const f of this.manifest.files) {
      if (f.binary) {
        skipped[f.path] = "binary file";
        continue;
      }
      if (f.large) {
        skipped[f.path] = "large diff (content withheld for speed)";
        continue;
      }
      files[f.path] = await sideContent(this.opts.repoRoot, this.range, "new", f.path);
    }
    return { revision, files, skipped };
  }

  /** Recompute the diff; bump revision + re-anchor comments if it changed. */
  async refresh(): Promise<boolean> {
    // Serialize concurrent refreshes (watcher + explicit CLI refresh).
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const signature = await this.watcher.computeSignature();
    this.range = await resolveRange(this.opts.repoRoot, this.session.range);
    this.stats.manifest_computes++;
    const [next, raw] = await Promise.all([
      computeManifest(this.opts.repoRoot, this.range, this.session.revision),
      computeRawDiff(this.opts.repoRoot, this.range),
    ]);
    this.manifestSignature = signature;
    // Raw diff text is the authoritative change detector — it catches
    // content-only edits that leave every per-file line count identical.
    if (raw === this.rawDiff) return false;

    const previousSections = splitFileSections(this.rawDiff);
    this.session.revision += 1;
    next.revision = this.session.revision;
    this.manifest = next;
    this.rawDiff = raw;
    this.applyScopeFlags();
    this.fileDiffCache.clear();
    await this.persistRevision();

    // Viewed flags survive revisions, but a file whose diff content changed
    // (or left the diff) needs another look — reset its flag (spec §2/§6).
    const sections = splitFileSections(raw);
    const stillViewed = this.session.viewed_files.filter(
      (f) => sections.has(f) && sections.get(f) === previousSections.get(f),
    );
    const viewedChanged = stillViewed.length !== this.session.viewed_files.length;
    this.session.viewed_files = stillViewed;

    await this.reanchorComments();
    await this.store.save(this.session);
    this.hub.broadcast("revision", {
      revision: this.session.revision,
      files: this.manifest.files.length,
      additions: this.manifest.additions,
      deletions: this.manifest.deletions,
    });
    if (viewedChanged) {
      this.hub.broadcast("viewed.changed", { viewed_files: this.session.viewed_files });
    }
    return true;
  }

  /**
   * Re-anchor every comment against the new revision (spec §6.4):
   *  - unchanged/shifted → follows silently, state unchanged;
   *  - anchored region modified → submitted/addressed become `addressed`
   *    (drafts stay drafts — the agent never saw them, so nothing was
   *    "responded to"; resolved stay resolved — they're settled);
   *  - deleted/unmatchable → `orphaned` (never dropped). Resolved comments
   *    are exempt: re-surfacing settled feedback would be noise.
   *  - orphaned comments are left for the reviewer to triage manually
   *    (re-anchor or dismiss, spec §6.4) — no automatic resurrection.
   */
  private async reanchorComments(): Promise<void> {
    const contentCache = new Map<string, string[] | null>();
    const content = async (file: string, side: Side): Promise<string[] | null> => {
      const key = `${side}\0${file}`;
      if (!contentCache.has(key)) {
        contentCache.set(key, await sideContent(this.opts.repoRoot, this.range, side, file));
      }
      return contentCache.get(key) ?? null;
    };

    for (const comment of this.session.comments) {
      if (comment.state === "resolved" || comment.state === "orphaned") continue;
      // Only line-anchored comments track content; review-level comments and
      // file notes are never addressed/orphaned automatically (QA gap §1.1).
      if (comment.kind !== "line" || comment.file === null) continue;
      if (comment.anchor.lines.length === 0) continue; // nothing to match against
      const lines = await content(comment.file, comment.side);
      const outcome = lines
        ? reanchorOutcome(comment.anchor, lines, comment.line)
        : ({ kind: "lost" } as const);

      if (outcome.kind === "lost") {
        comment.state = "orphaned";
        comment.updated_at = new Date().toISOString();
        continue;
      }
      // A fuzz-placed "match" can hide drift in the surrounding context (QA
      // bug §2.1: a rewrite that preserves one common line). Compare the FULL
      // anchor window against the new content BEFORE refreshing the anchor —
      // any drift means the region was modified.
      const modified =
        outcome.kind === "modified" ||
        !anchorWindowIntact(comment.anchor, lines!, outcome.line);
      comment.line = outcome.line;
      comment.end_line = outcome.end_line;
      comment.revision = this.session.revision;
      // Refresh the anchor so future re-anchors track the current content.
      comment.anchor = buildAnchor(lines!, outcome.line, outcome.end_line);
      if (modified && (comment.state === "submitted" || comment.state === "addressed")) {
        comment.state = "addressed";
        comment.updated_at = new Date().toISOString();
      }
    }
  }

  // -------------------------------------------------------------------------
  // HTTP routing

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.lastActivity = Date.now();
    try {
      return await this.dispatch(req, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  }

  private async dispatch(req: Request, url: URL): Promise<Response> {
    const { pathname } = url;
    const method = req.method;

    if (pathname === "/api/health") {
      return json({ ok: true, pid: process.pid, stats: this.stats });
    }

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(Bun.file(UI_PATH), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Built frontend assets (Vite emits content-hashed files under /assets/).
    if (method === "GET" && pathname.startsWith("/assets/")) {
      const rel = path.normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
      if (rel.startsWith("assets" + path.sep)) {
        const file = Bun.file(path.join(PUBLIC_DIR, rel));
        if (await file.exists()) {
          return new Response(file, {
            headers: { "cache-control": "public, max-age=31536000, immutable" },
          });
        }
      }
      return json({ error: "not found" }, 404);
    }

    if (pathname === "/events") return this.hub.sseResponse(req.signal);

    if (pathname === "/api/open" && method === "POST") {
      const body = await readBody(req);
      const range = typeof body["range"] === "string" ? body["range"] : this.session.range;
      const scope = typeof body["scope"] === "string" ? body["scope"] : null;
      const rawScopeFiles = body["scope_files"];
      const scopeFiles =
        Array.isArray(rawScopeFiles) && rawScopeFiles.every((p) => typeof p === "string")
          ? (rawScopeFiles as string[])
          : null;
      if (range !== this.session.range) {
        await this.openSession(range, scope, scopeFiles);
      } else {
        if (this.applyScope(scope, scopeFiles)) {
          this.applyScopeFlags(); // flags depend on the (changed) scope
          await this.store.save(this.session);
          this.hub.broadcast("session.changed", { session_id: this.session.session_id });
        }
        // Warm open: skip the manifest recompute entirely when the repo's
        // change signature still matches the one the manifest was built at.
        const signature = await this.watcher.computeSignature();
        if (this.manifestSignature === null || signature !== this.manifestSignature) {
          await this.refresh();
        }
        if (this.session.session_state === "ready") {
          // Re-opening a ready session starts a new review round.
          this.session.session_state = "reviewing";
          delete this.session.ready_at;
          await this.store.save(this.session);
          this.hub.broadcast("session.changed", { session_id: this.session.session_id });
        }
      }
      const result: OpenResult = {
        session_id: this.session.session_id,
        url: this.url,
        files: this.manifest.files.length,
        additions: this.manifest.additions,
        deletions: this.manifest.deletions,
        revision: this.session.revision,
        session_state: this.session.session_state,
      };
      return json(result);
    }

    if (pathname === "/api/session") return json(this.session);

    if (pathname === "/api/status") return json(this.status());

    if (pathname === "/api/revisions") {
      const available = await this.revisions.list(this.session.session_id);
      const revisions = (
        await Promise.all(
          available.map(async (n) => {
            const snap = await this.revisions.load(this.session.session_id, n);
            if (!snap) return null;
            return {
              revision: snap.revision,
              created_at: snap.created_at,
              files: snap.manifest.files.length,
              additions: snap.manifest.additions,
              deletions: snap.manifest.deletions,
            };
          }),
        )
      ).filter((r) => r !== null);
      const result: RevisionsResult = { current: this.session.revision, available, revisions };
      return json(result);
    }

    // Full file content for one side of the current revision — used by the
    // UI's "Expand context" (spec §3.2). Current revision only.
    if (pathname === "/api/file" && method === "GET") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ error: "missing ?path=" }, 400);
      const side: Side = url.searchParams.get("side") === "old" ? "old" : "new";
      const inManifest = this.manifest.files.some(
        (f) => f.path === filePath || f.old_path === filePath,
      );
      if (!inManifest) return json({ error: `not in diff: ${filePath}` }, 404);
      const lines = await sideContent(this.opts.repoRoot, this.range, side, filePath);
      if (lines === null) return json({ error: `no ${side}-side content: ${filePath}` }, 404);
      const result: FileContentResult = { path: filePath, side, lines };
      return json(result);
    }

    if (pathname === "/api/diff") {
      const revision = parseRevision(url);
      if (revision instanceof Response) return revision;
      if (revision === null || revision === this.session.revision) return json(this.manifest);
      const snapshot = await this.revisions.load(this.session.session_id, revision);
      if (!snapshot) return json({ error: `revision not found: ${revision}` }, 404);
      return json(snapshot.manifest);
    }

    if (pathname === "/api/diff/file") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ error: "missing ?path=" }, 400);
      const revision = parseRevision(url);
      if (revision instanceof Response) return revision;
      if (revision !== null && revision !== this.session.revision) {
        return this.historicalFileDiff(revision, filePath);
      }
      const file = this.manifest.files.find((f) => f.path === filePath);
      if (!file) return json({ error: `not in diff: ${filePath}` }, 404);
      const force = url.searchParams.get("force") === "1";
      return json(await this.fileDiff(file, force));
    }

    if (pathname === "/api/interdiff/manifest" && method === "GET") {
      return this.interdiffManifest(url);
    }

    if (pathname === "/api/interdiff" && method === "GET") {
      return this.interdiffFile(url);
    }

    if (pathname === "/api/comments" && method === "GET") {
      return json({ comments: this.filterComments(url) });
    }

    if (pathname === "/api/comments" && method === "POST") {
      return this.createComment(await readBody(req));
    }

    const commentMatch = /^\/api\/comments\/([^/]+)(?:\/(resolve|reply|send|reanchor))?$/.exec(
      pathname,
    );
    if (commentMatch) {
      const [, id = "", action] = commentMatch;
      if (method === "POST" && action === "resolve") {
        return this.resolveComment(id, await readBody(req));
      }
      if (method === "POST" && action === "reply") {
        return this.replyComment(id, await readBody(req));
      }
      if (method === "POST" && action === "send") return this.sendComment(id);
      if (method === "POST" && action === "reanchor") {
        return this.reanchorComment(id, await readBody(req));
      }
      if (method === "PATCH" && !action) return this.updateComment(id, await readBody(req));
      if (method === "DELETE" && !action) return this.deleteComment(id);
      if (method === "GET" && !action) {
        const comment = findComment(this.session, id);
        return comment ? json(comment) : json({ error: "comment not found" }, 404);
      }
    }

    if (pathname === "/api/feedback/send" && method === "POST") {
      return this.sendFeedback();
    }

    if (pathname === "/api/session/mark-ready" && method === "POST") {
      return this.markReady();
    }

    if (pathname === "/api/viewed" && method === "POST") {
      return this.setViewed(await readBody(req));
    }

    if (pathname === "/api/refresh" && method === "POST") {
      const changed = await this.refresh();
      return json({
        changed,
        revision: this.session.revision,
        files: this.manifest.files.length,
        additions: this.manifest.additions,
        deletions: this.manifest.deletions,
      });
    }

    if (pathname === "/api/wait") return this.wait(url);

    if (pathname === "/api/shutdown" && method === "POST") {
      setTimeout(() => void this.shutdown("stop requested"), 50);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  }

  /**
   * Per-file hunks with an in-memory LRU cache for the current revision
   * (the cache is cleared on every revision bump / session change), so
   * collapsing and re-expanding a file doesn't re-pay the git subprocess.
   */
  private async fileDiff(file: ManifestFile, force: boolean): Promise<FileDiff> {
    const key = `${force ? "force" : ""}\0${file.path}`;
    const cached = this.fileDiffCache.get(key);
    if (cached) {
      this.stats.file_diff_cache_hits++;
      // Re-insert to mark as most recently used.
      this.fileDiffCache.delete(key);
      this.fileDiffCache.set(key, cached);
      return cached;
    }
    this.stats.file_diff_computes++;
    const result = await computeFileDiff(this.opts.repoRoot, this.range, file, { force });
    this.fileDiffCache.set(key, result);
    if (this.fileDiffCache.size > FILE_DIFF_CACHE_MAX) {
      const oldest = this.fileDiffCache.keys().next().value;
      if (oldest !== undefined) this.fileDiffCache.delete(oldest);
    }
    return result;
  }

  /** Serve a file's hunks for an older revision from its stored raw diff. */
  private async historicalFileDiff(revision: number, filePath: string): Promise<Response> {
    const snapshot = await this.revisions.load(this.session.session_id, revision);
    if (!snapshot) return json({ error: `revision not found: ${revision}` }, 404);
    const file = snapshot.manifest.files.find((f) => f.path === filePath);
    if (!file) return json({ error: `not in diff at revision ${revision}: ${filePath}` }, 404);
    const section = splitFileSections(snapshot.raw_diff).get(filePath) ?? "";
    const parsed = parseUnifiedDiff(section);
    const result: FileDiff = {
      path: file.path,
      binary: file.binary || parsed.binary,
      large: false, // history is served whole; the snapshot already paid the cost
      hunks: parsed.hunks,
    };
    if (file.old_path) result.old_path = file.old_path;
    return json(result);
  }

  // -------------------------------------------------------------------------
  // Interdiff: what changed in a file BETWEEN two revisions (QA gap §1.4)

  /** One side's new-side lines at a revision, or why they're unavailable. */
  private async interdiffSide(
    snapshot: RevisionSnapshot,
    contents: RevisionContents | null,
    filePath: string,
  ): Promise<{ ok: true; lines: string[] | null } | { ok: false; reason: string }> {
    const changed = snapshot.manifest.files.some((f) => f.path === filePath);
    if (!changed) {
      // Untouched at this revision: the new side equals the (stable) base.
      return { ok: true, lines: await sideContent(this.opts.repoRoot, this.range, "old", filePath) };
    }
    if (contents !== null) {
      if (Object.hasOwn(contents.files, filePath)) {
        return { ok: true, lines: contents.files[filePath] ?? null };
      }
      const skipReason = contents.skipped[filePath];
      if (skipReason !== undefined) {
        return { ok: false, reason: `${skipReason} at revision ${snapshot.revision}` };
      }
    }
    return { ok: false, reason: `content not recorded for revision ${snapshot.revision}` };
  }

  /** Parse and validate ?from=&to= revision params against stored history. */
  private async interdiffRange(
    url: URL,
  ): Promise<
    | { from: RevisionSnapshot; to: RevisionSnapshot; fromC: RevisionContents | null; toC: RevisionContents | null }
    | Response
  > {
    const parse = (name: string): number | Response => {
      const raw = url.searchParams.get(name);
      if (raw === null) return json({ error: `missing ?${name}=` }, 400);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) return json({ error: `invalid ${name}: ${raw}` }, 400);
      return n;
    };
    const fromN = parse("from");
    if (fromN instanceof Response) return fromN;
    const toN = parse("to");
    if (toN instanceof Response) return toN;
    if (fromN === toN) return json({ error: "from and to must differ" }, 400);
    const sessionId = this.session.session_id;
    const [from, to, fromC, toC] = await Promise.all([
      this.revisions.load(sessionId, fromN),
      this.revisions.load(sessionId, toN),
      this.revisions.loadContents(sessionId, fromN),
      this.revisions.loadContents(sessionId, toN),
    ]);
    if (!from) return json({ error: `revision not found: ${fromN}` }, 404);
    if (!to) return json({ error: `revision not found: ${toN}` }, 404);
    return { from, to, fromC, toC };
  }

  /** Per-file add/del counts between two revisions (files that changed). */
  private async interdiffManifest(url: URL): Promise<Response> {
    const range = await this.interdiffRange(url);
    if (range instanceof Response) return range;
    const { from, to, fromC, toC } = range;

    const candidates = [
      ...new Set([
        ...from.manifest.files.map((f) => f.path),
        ...to.manifest.files.map((f) => f.path),
      ]),
    ].sort();

    const entries = await mapLimit(candidates, 8, async (p): Promise<InterdiffFileSummary | null> => {
      const a = await this.interdiffSide(from, fromC, p);
      const b = await this.interdiffSide(to, toC, p);
      if (!a.ok || !b.ok) {
        const reason = !a.ok ? a.reason : (b as { ok: false; reason: string }).reason;
        return { path: p, additions: 0, deletions: 0, available: false, reason };
      }
      if (linesEqual(a.lines, b.lines)) return null; // untouched between revisions
      const d = await diffLinesNoIndex(a.lines, b.lines);
      if (d.hunks.length === 0) return null;
      return { path: p, additions: d.additions, deletions: d.deletions, available: true };
    });

    const files = entries.filter((e): e is InterdiffFileSummary => e !== null);
    const result: InterdiffManifest = {
      from: from.revision,
      to: to.revision,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
    return json(result);
  }

  /** Structured hunks of one file's change between two revisions. */
  private async interdiffFile(url: URL): Promise<Response> {
    const filePath = url.searchParams.get("file");
    if (!filePath) return json({ error: "missing ?file=" }, 400);
    const range = await this.interdiffRange(url);
    if (range instanceof Response) return range;
    const { from, to, fromC, toC } = range;

    const inEither =
      from.manifest.files.some((f) => f.path === filePath) ||
      to.manifest.files.some((f) => f.path === filePath);
    if (!inEither) {
      return json(
        { error: `not in diff at revision ${from.revision} or ${to.revision}: ${filePath}` },
        404,
      );
    }
    const a = await this.interdiffSide(from, fromC, filePath);
    const b = await this.interdiffSide(to, toC, filePath);
    if (!a.ok || !b.ok) {
      const reason = !a.ok ? a.reason : (b as { ok: false; reason: string }).reason;
      return json({ error: `interdiff not available for ${filePath}: ${reason}`, reason }, 409);
    }
    const d = await diffLinesNoIndex(a.lines, b.lines);
    const result: InterdiffFile = {
      path: filePath,
      from: from.revision,
      to: to.revision,
      binary: false,
      large: false,
      hunks: d.hunks,
    };
    return json(result);
  }

  private filterComments(url: URL): ReviewComment[] {
    let comments = this.session.comments;
    if (url.searchParams.get("exclude_drafts") === "1") {
      comments = comments.filter((c) => c.state !== "draft");
    }
    if (url.searchParams.get("unresolved") === "1") {
      comments = comments.filter((c) => c.state !== "resolved");
    }
    const stateFilter = url.searchParams.get("state");
    if (stateFilter) {
      const states = new Set(stateFilter.split(","));
      comments = comments.filter((c) => states.has(c.state));
    }
    // Review-level comments first (they frame everything else); otherwise
    // stable creation order.
    return comments
      .slice()
      .sort((a, b) => Number(a.kind !== "review") - Number(b.kind !== "review"));
  }

  private status(): StatusResult {
    return {
      session_id: this.session.session_id,
      range: this.session.range,
      session_state: this.session.session_state,
      revision: this.session.revision,
      url: this.url,
      scope: this.session.scope,
      scope_files: this.session.scope_files,
      comments: commentCounts(this.session),
      viewed_files: this.session.viewed_files.length,
    };
  }

  // -------------------------------------------------------------------------
  // Comment handlers

  /**
   * Comments are always created as drafts (spec §4.2); submission happens
   * via /api/feedback/send or /api/comments/:id/send. Three kinds:
   *  - no `file` → a review-level comment (kind "review", QA gap §1.1);
   *  - `file` with `line: 0` → a file note (kind "file-note");
   *  - `file` with `line ≥ 1` → a classic line-anchored comment.
   */
  private async createComment(body: JsonBody): Promise<Response> {
    const text = body["text"];
    if (typeof text !== "string") return json({ error: "required: text (string)" }, 400);
    const rawFile = body["file"];
    if (rawFile !== undefined && rawFile !== null && typeof rawFile !== "string") {
      return json({ error: "file must be a string (omit it for a review-level comment)" }, 400);
    }
    const file = typeof rawFile === "string" ? rawFile : null;
    const side: Side = body["side"] === "old" ? "old" : "new";
    const tag = parseTag(body["tag"]);
    if (tag instanceof Response) return tag;

    let input: NewCommentInput;
    let anchor: CommentAnchor = { context_before: [], lines: [], context_after: [] };
    if (file === null) {
      const line = body["line"];
      if (line !== undefined && line !== 0) {
        return json({ error: "review-level comments (no file) must omit line" }, 400);
      }
      input = { file: null, line: 0, end_line: 0, side, kind: "review", text, tag };
    } else {
      const line = body["line"];
      if (typeof line !== "number" || !Number.isInteger(line) || line < 0) {
        return json(
          { error: "required: line (number ≥ 1; 0 for a file note; omit file for review-level)" },
          400,
        );
      }
      if (line === 0) {
        input = { file, line: 0, end_line: 0, side, kind: "file-note", text, tag };
      } else {
        const endLine = typeof body["end_line"] === "number" ? body["end_line"] : line;
        if (endLine < line) return json({ error: "invalid line range" }, 400);
        input = { file, line, end_line: endLine, side, kind: "line", text, tag };
        const content = await sideContent(this.opts.repoRoot, this.range, side, file);
        if (content) anchor = buildAnchor(content, line, endLine);
      }
    }
    const comment = addComment(this.session, input, anchor);
    await this.store.save(this.session);
    this.hub.broadcast("comment.created", { comment });
    return json(comment, 201);
  }

  private async resolveComment(id: string, body: JsonBody): Promise<Response> {
    const existing = findComment(this.session, id);
    if (!existing) return json({ error: "comment not found" }, 404);
    if (existing.state === "draft") {
      return json({ error: "cannot resolve a draft comment (send it first)" }, 400);
    }
    const replyText = typeof body["reply"] === "string" ? body["reply"] : undefined;
    const comment = resolveComment(
      this.session,
      id,
      replyText !== undefined ? { from: "agent", text: replyText } : undefined,
    );
    await this.store.save(this.session);
    this.hub.broadcast("comment.resolved", { comment });
    return json(comment);
  }

  private async replyComment(id: string, body: JsonBody): Promise<Response> {
    const text = body["text"];
    if (typeof text !== "string") return json({ error: "required: text" }, 400);
    const from = body["from"] === "reviewer" ? "reviewer" : "agent";
    const comment = addReply(this.session, id, { from, text });
    if (!comment) return json({ error: "comment not found" }, 404);
    await this.store.save(this.session);
    this.hub.broadcast("comment.updated", { comment });
    return json(comment);
  }

  /**
   * PATCH /api/comments/:id — draft autosave (text/tag) and reviewer state
   * changes (resolve, or reopen back to submitted). Draft → submitted must go
   * through the send endpoints so the batch is recorded and `wait` wakes.
   */
  private async updateComment(id: string, body: JsonBody): Promise<Response> {
    const comment = findComment(this.session, id);
    if (!comment) return json({ error: "comment not found" }, 404);
    if (typeof body["text"] === "string") comment.text = body["text"];
    if ("tag" in body) {
      const tag = parseTag(body["tag"]);
      if (tag instanceof Response) return tag;
      comment.tag = tag;
    }
    const state = body["state"];
    if (state !== undefined) {
      if (typeof state !== "string" || !COMMENT_STATES.has(state)) {
        return json({ error: `invalid state: ${String(state)}` }, 400);
      }
      if (state !== comment.state) {
        if (comment.state === "draft" || state === "draft") {
          return json(
            { error: "drafts change state via /api/feedback/send or /api/comments/:id/send" },
            400,
          );
        }
        if (state !== "resolved" && state !== "submitted") {
          return json({ error: `cannot set state to ${state} (resolved or submitted only)` }, 400);
        }
        comment.state = state;
      }
    }
    comment.updated_at = new Date().toISOString();
    await this.store.save(this.session);
    this.hub.broadcast("comment.updated", { comment });
    return json(comment);
  }

  /**
   * POST /api/comments/:id/reanchor — orphaned-comment triage (spec §6.4).
   * Either `{ line, end_line?, side? }` (re-anchor manually to a picked line)
   * or `{ file_note: true }` (convert to a file-level note: line 0, no anchor,
   * so it survives every future revision untouched). Both land the comment
   * back in `submitted`. Dismissing an orphan is a plain PATCH to `resolved`.
   */
  private async reanchorComment(id: string, body: JsonBody): Promise<Response> {
    const comment = findComment(this.session, id);
    if (!comment) return json({ error: "comment not found" }, 404);
    if (comment.state !== "orphaned") {
      return json({ error: `not orphaned (state: ${comment.state})` }, 400);
    }
    if (comment.file === null) {
      return json({ error: "review-level comments have no anchor to re-anchor" }, 400);
    }

    if (body["file_note"] === true) {
      comment.line = 0;
      comment.end_line = 0;
      comment.kind = "file-note";
      comment.anchor = { context_before: [], lines: [], context_after: [] };
    } else {
      const line = body["line"];
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
        return json({ error: "required: line (number ≥ 1) or file_note: true" }, 400);
      }
      const endLine = typeof body["end_line"] === "number" ? body["end_line"] : line;
      if (endLine < line) return json({ error: "invalid line range" }, 400);
      const side: Side = body["side"] === "old" ? "old" : "new";
      const content = await sideContent(this.opts.repoRoot, this.range, side, comment.file);
      if (content === null) {
        return json({ error: `no ${side}-side content: ${comment.file}` }, 404);
      }
      comment.line = line;
      comment.end_line = Math.min(endLine, content.length);
      comment.side = side;
      comment.kind = "line";
      comment.anchor = buildAnchor(content, comment.line, comment.end_line);
    }
    comment.state = "submitted";
    comment.revision = this.session.revision;
    comment.updated_at = new Date().toISOString();
    await this.store.save(this.session);
    this.hub.broadcast("comment.updated", { comment });
    return json(comment);
  }

  private async deleteComment(id: string): Promise<Response> {
    if (!deleteComment(this.session, id)) return json({ error: "comment not found" }, 404);
    await this.store.save(this.session);
    this.hub.broadcast("comment.deleted", { id });
    return json({ ok: true });
  }

  // -------------------------------------------------------------------------
  // Session actions (spec §5)

  /** "Send Feedback": every draft becomes submitted as one batch. */
  private async sendFeedback(): Promise<Response> {
    const drafts = this.session.comments.filter((c) => c.state === "draft");
    if (drafts.length === 0) return json({ error: "no draft comments to send" }, 400);
    const batch = submitComments(this.session, drafts);
    await this.store.save(this.session);
    this.hub.broadcast("feedback.sent", { batch, comments: drafts });
    return json({ batch, comments: drafts });
  }

  /** "Send this comment now": a single-comment batch (spec §5.1). */
  private async sendComment(id: string): Promise<Response> {
    const comment = findComment(this.session, id);
    if (!comment) return json({ error: "comment not found" }, 404);
    if (comment.state !== "draft") {
      return json({ error: `not a draft (state: ${comment.state})` }, 400);
    }
    const batch = submitComments(this.session, [comment]);
    await this.store.save(this.session);
    this.hub.broadcast("feedback.sent", { batch, comments: [comment] });
    return json(comment);
  }

  /** "Mark Ready": allowed with open comments — flagged, not blocked (§5.2). */
  private async markReady(): Promise<Response> {
    this.session.session_state = "ready";
    this.session.ready_at = new Date().toISOString();
    await this.store.save(this.session);
    this.hub.broadcast("session.ready", { session_id: this.session.session_id });
    const result: MarkReadyResult = {
      ok: true,
      session_state: "ready",
      ready_at: this.session.ready_at,
      comments: commentCounts(this.session),
    };
    return json(result);
  }

  private async setViewed(body: JsonBody): Promise<Response> {
    const viewed = body["viewed"];
    if (typeof viewed !== "boolean") return json({ error: "required: viewed (boolean)" }, 400);
    const files = Array.isArray(body["files"])
      ? (body["files"] as unknown[])
      : typeof body["file"] === "string"
        ? [body["file"]]
        : null;
    if (!files || files.some((f) => typeof f !== "string")) {
      return json({ error: "required: file (string) or files (string[])" }, 400);
    }
    let changed = false;
    for (const file of files as string[]) {
      changed = setViewed(this.session, file, viewed) || changed;
    }
    if (changed) {
      await this.store.save(this.session);
      this.hub.broadcast("viewed.changed", { viewed_files: this.session.viewed_files });
    }
    return json({ viewed_files: this.session.viewed_files });
  }

  // -------------------------------------------------------------------------
  // Bounded long-poll for agents

  /**
   * Returns on: Mark Ready (`ready`), a feedback batch or send-now
   * (`feedback`, with that batch's comments), or timeout. Drafts never
   * trigger a wait — they're invisible to the agent until sent.
   */
  private wait(url: URL): Promise<Response> {
    const timeoutS = Number(url.searchParams.get("timeout") ?? "60");
    const timeoutMs = Math.min(Math.max(timeoutS, 0), 3600) * 1_000;

    const result = (reason: WaitReason, batch: FeedbackBatch | null): WaitResult => ({
      reason,
      session_state: this.session.session_state,
      revision: this.session.revision,
      batch_id: batch?.id ?? null,
      comments: batch
        ? this.session.comments.filter((c) => batch.comment_ids.includes(c.id))
        : [],
    });

    if (this.session.session_state === "ready") {
      return Promise.resolve(json(result("ready", null)));
    }

    return new Promise<Response>((resolve) => {
      let done = false;
      const finish = (reason: WaitReason, batch: FeedbackBatch | null) => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        this.lastActivity = Date.now();
        resolve(json(result(reason, batch)));
      };
      const timer = setTimeout(() => finish("timeout", null), timeoutMs);
      const unsubscribe = this.hub.onEvent((event, data) => {
        if (event === "session.ready") finish("ready", null);
        else if (event === "feedback.sent") {
          finish("feedback", (data as { batch: FeedbackBatch }).batch);
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------

/** Parse ?revision=N; null when absent (= latest). */
function parseRevision(url: URL): number | null | Response {
  const raw = url.searchParams.get("revision");
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return json({ error: `invalid revision: ${raw}` }, 400);
  return n;
}

function parseTag(value: unknown): CommentTag | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && COMMENT_TAGS.has(value)) return value as CommentTag;
  return json({ error: `invalid tag: ${String(value)} (must-fix|suggestion|question|nit)` }, 400);
}

/** Content equality where null means "file absent on the new side". */
function linesEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(req: Request): Promise<JsonBody> {
  try {
    const body = (await req.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as JsonBody) : {};
  } catch {
    return {};
  }
}
