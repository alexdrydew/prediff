/**
 * Per-repo daemon: Bun.serve JSON API + SSE + static UI + repo watcher +
 * idle-TTL self-shutdown. See ARCHITECTURE.md §2 and §4; review-model
 * semantics per design/prediff-interaction-spec.md.
 */

import path from "node:path";
import type {
  CommentTag,
  DiffManifest,
  FeedbackBatch,
  FileContentResult,
  FileDiff,
  ManifestFile,
  MarkReadyResult,
  OpenResult,
  ReviewComment,
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
  parseUnifiedDiff,
  resolveRange,
  sideContent,
  splitFileSections,
  type ResolvedRange,
} from "../git/diff";
import { buildAnchor, reanchorOutcome } from "../store/anchor";
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
  private async openSession(rangeSpec: string, scope: string | null): Promise<void> {
    // Capture the change signature BEFORE computing the manifest: anything
    // that changes afterwards is guaranteed to produce a mismatch later.
    const signature = await this.watcher.computeSignature();
    this.range = await resolveRange(this.opts.repoRoot, rangeSpec);
    const existing = await this.store.loadCurrent();
    if (existing && existing.range === rangeSpec) {
      this.session = existing;
      if (scope !== null && scope !== this.session.scope) {
        this.session.scope = scope;
        await this.store.save(this.session);
      }
    } else {
      this.session = await this.store.create(this.opts.repoRoot, rangeSpec, scope);
      this.hub.broadcast("session.changed", { session_id: this.session.session_id });
    }
    this.stats.manifest_computes++;
    [this.manifest, this.rawDiff] = await Promise.all([
      computeManifest(this.opts.repoRoot, this.range, this.session.revision),
      computeRawDiff(this.opts.repoRoot, this.range),
    ]);
    this.manifestSignature = signature;
    this.fileDiffCache.clear();
    await this.persistRevision();
  }

  /**
   * Persist the current revision's snapshot. If a snapshot for this number
   * already exists but the diff has drifted (daemon restarted after edits,
   * before any refresh bumped the number), overwrite it so history always
   * matches what /api/diff reports for that revision.
   */
  private async persistRevision(): Promise<void> {
    const existing = await this.revisions.load(this.session.session_id, this.session.revision);
    if (existing && existing.raw_diff === this.rawDiff) return;
    await this.revisions.save(this.session.session_id, {
      revision: this.session.revision,
      created_at: new Date().toISOString(),
      manifest: this.manifest,
      raw_diff: this.rawDiff,
    });
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
      comment.line = outcome.line;
      comment.end_line = outcome.end_line;
      comment.revision = this.session.revision;
      // Refresh the anchor so future re-anchors track the current content.
      comment.anchor = buildAnchor(lines!, outcome.line, outcome.end_line);
      if (
        outcome.kind === "modified" &&
        (comment.state === "submitted" || comment.state === "addressed")
      ) {
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
      if (range !== this.session.range) {
        await this.openSession(range, scope);
      } else {
        if (scope !== null && scope !== this.session.scope) {
          this.session.scope = scope;
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
    return comments;
  }

  private status(): StatusResult {
    return {
      session_id: this.session.session_id,
      range: this.session.range,
      session_state: this.session.session_state,
      revision: this.session.revision,
      url: this.url,
      scope: this.session.scope,
      comments: commentCounts(this.session),
      viewed_files: this.session.viewed_files.length,
    };
  }

  // -------------------------------------------------------------------------
  // Comment handlers

  /** Comments are always created as drafts (spec §4.2); submission happens
   * via /api/feedback/send or /api/comments/:id/send. */
  private async createComment(body: JsonBody): Promise<Response> {
    const file = body["file"];
    const line = body["line"];
    const text = body["text"];
    if (typeof file !== "string" || typeof line !== "number" || typeof text !== "string") {
      return json({ error: "required: file (string), line (number), text (string)" }, 400);
    }
    const side: Side = body["side"] === "old" ? "old" : "new";
    const endLine = typeof body["end_line"] === "number" ? body["end_line"] : line;
    if (endLine < line || line < 1) return json({ error: "invalid line range" }, 400);
    const tag = parseTag(body["tag"]);
    if (tag instanceof Response) return tag;

    const input: NewCommentInput = { file, line, end_line: endLine, side, text, tag };
    const content = await sideContent(this.opts.repoRoot, this.range, side, file);
    const anchor = content
      ? buildAnchor(content, line, endLine)
      : { context_before: [], lines: [], context_after: [] };
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

    if (body["file_note"] === true) {
      comment.line = 0;
      comment.end_line = 0;
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
