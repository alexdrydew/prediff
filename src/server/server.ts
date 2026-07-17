/**
 * Per-repo daemon: Bun.serve JSON API + SSE + static UI + repo watcher +
 * idle-TTL self-shutdown. See ARCHITECTURE.md §2.
 */

import path from "node:path";
import type {
  DiffManifest,
  ManifestFile,
  OpenResult,
  Session,
  Side,
  StatusResult,
  WaitReason,
  WaitResult,
} from "../types";
import {
  computeFileDiff,
  computeManifest,
  resolveRange,
  sideContent,
  type ResolvedRange,
} from "../git/diff";
import { buildAnchor, reanchor } from "../store/anchor";
import {
  SessionStore,
  addComment,
  addReply,
  deleteComment,
  findComment,
  resolveComment,
  type NewCommentInput,
} from "../store/session";
import { EventHub } from "./events";
import { RepoWatcher } from "./watcher";
import { removeLockfile, writeLockfile } from "./lockfile";

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

interface JsonBody {
  [key: string]: unknown;
}

export class Daemon {
  private readonly store: SessionStore;
  private readonly hub = new EventHub();
  private session!: Session;
  private range!: ResolvedRange;
  private manifest!: DiffManifest;
  private watcher: RepoWatcher;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private lastActivity = Date.now();
  private ttlTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly opts: DaemonOptions) {
    this.store = new SessionStore(opts.stateDir);
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
    await this.openSession(this.opts.range);

    this.server = Bun.serve({
      port: this.opts.port ?? 0,
      hostname: "127.0.0.1",
      idleTimeout: 0, // long-polls and SSE must not be cut off
      fetch: (req) => this.route(req),
    });

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

  async shutdown(reason: string): Promise<never> {
    console.log(`[prediff] shutting down: ${reason}`);
    this.watcher.stop();
    if (this.ttlTimer) clearInterval(this.ttlTimer);
    await removeLockfile(this.opts.stateDir);
    this.server?.stop(true);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Session / diff lifecycle

  /** Create or reuse the current session for `rangeSpec`, then refresh. */
  private async openSession(rangeSpec: string): Promise<void> {
    this.range = await resolveRange(this.opts.repoRoot, rangeSpec);
    const existing = await this.store.loadCurrent();
    if (existing && existing.range === rangeSpec) {
      this.session = existing;
    } else {
      this.session = await this.store.create(this.opts.repoRoot, rangeSpec);
      this.hub.broadcast("session.changed", { session_id: this.session.session_id });
    }
    this.manifest = await computeManifest(this.opts.repoRoot, this.range, this.session.generation);
  }

  /** Recompute the diff; bump generation + re-anchor comments if it changed. */
  async refresh(): Promise<boolean> {
    // Serialize concurrent refreshes (watcher + explicit CLI refresh).
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    this.range = await resolveRange(this.opts.repoRoot, this.session.range);
    const next = await computeManifest(this.opts.repoRoot, this.range, this.session.generation);
    if (filesSignature(next.files) === filesSignature(this.manifest.files)) {
      return false;
    }
    this.session.generation += 1;
    next.generation = this.session.generation;
    this.manifest = next;
    await this.reanchorComments();
    await this.store.save(this.session);
    this.hub.broadcast("generation", {
      generation: this.session.generation,
      files: this.manifest.files.length,
      additions: this.manifest.additions,
      deletions: this.manifest.deletions,
    });
    return true;
  }

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
      if (comment.anchor.lines.length === 0) continue; // nothing to match against
      const lines = await content(comment.file, comment.side);
      const match = lines ? reanchor(comment.anchor, lines, comment.line) : null;
      if (match) {
        comment.line = match.line;
        comment.end_line = match.end_line;
        comment.generation = this.session.generation;
        if (comment.state === "outdated") comment.state = "open";
      } else if (comment.state === "open") {
        comment.state = "outdated";
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

    if (pathname === "/api/health") return json({ ok: true, pid: process.pid });

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
      if (range !== this.session.range) {
        await this.openSession(range);
      } else {
        await this.refresh();
        if (this.session.review_state === "submitted") {
          // Re-opening a submitted session starts a new review round.
          this.session.review_state = "reviewing";
          delete this.session.submitted_at;
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
      };
      return json(result);
    }

    if (pathname === "/api/session") return json(this.session);

    if (pathname === "/api/status") return json(this.status());

    if (pathname === "/api/diff") return json(this.manifest);

    if (pathname === "/api/diff/file") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ error: "missing ?path=" }, 400);
      const file = this.manifest.files.find((f) => f.path === filePath);
      if (!file) return json({ error: `not in diff: ${filePath}` }, 404);
      const force = url.searchParams.get("force") === "1";
      return json(await computeFileDiff(this.opts.repoRoot, this.range, file, { force }));
    }

    if (pathname === "/api/comments" && method === "GET") {
      const unresolved = url.searchParams.get("unresolved") === "1";
      const comments = unresolved
        ? this.session.comments.filter((c) => c.state !== "resolved")
        : this.session.comments;
      return json({ comments });
    }

    if (pathname === "/api/comments" && method === "POST") {
      return this.createComment(await readBody(req));
    }

    const commentMatch = /^\/api\/comments\/([^/]+)(?:\/(resolve|reply))?$/.exec(pathname);
    if (commentMatch) {
      const [, id = "", action] = commentMatch;
      if (method === "POST" && action === "resolve") {
        return this.resolveComment(id, await readBody(req));
      }
      if (method === "POST" && action === "reply") {
        return this.replyComment(id, await readBody(req));
      }
      if (method === "PATCH" && !action) return this.updateComment(id, await readBody(req));
      if (method === "DELETE" && !action) return this.deleteComment(id);
      if (method === "GET" && !action) {
        const comment = findComment(this.session, id);
        return comment ? json(comment) : json({ error: "comment not found" }, 404);
      }
    }

    if (pathname === "/api/review/submit" && method === "POST") {
      this.session.review_state = "submitted";
      this.session.submitted_at = new Date().toISOString();
      await this.store.save(this.session);
      this.hub.broadcast("review.submitted", { session_id: this.session.session_id });
      return json({ ok: true, review_state: this.session.review_state });
    }

    if (pathname === "/api/refresh" && method === "POST") {
      const changed = await this.refresh();
      return json({
        changed,
        generation: this.session.generation,
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

  private status(): StatusResult {
    const counts = { total: 0, open: 0, resolved: 0, outdated: 0 };
    for (const c of this.session.comments) {
      counts.total++;
      counts[c.state]++;
    }
    return {
      session_id: this.session.session_id,
      range: this.session.range,
      review_state: this.session.review_state,
      generation: this.session.generation,
      url: this.url,
      comments: counts,
    };
  }

  // -------------------------------------------------------------------------
  // Comment handlers

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

    const input: NewCommentInput = { file, line, end_line: endLine, side, text };
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
    const replyText = typeof body["reply"] === "string" ? body["reply"] : undefined;
    const comment = resolveComment(
      this.session,
      id,
      replyText !== undefined ? { from: "agent", text: replyText } : undefined,
    );
    if (!comment) return json({ error: "comment not found" }, 404);
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

  private async updateComment(id: string, body: JsonBody): Promise<Response> {
    const comment = findComment(this.session, id);
    if (!comment) return json({ error: "comment not found" }, 404);
    if (typeof body["text"] === "string") comment.text = body["text"];
    if (body["state"] === "open" || body["state"] === "resolved") {
      comment.state = body["state"];
    }
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
  // Bounded long-poll for agents

  private wait(url: URL): Promise<Response> {
    const timeoutS = Number(url.searchParams.get("timeout") ?? "60");
    const timeoutMs = Math.min(Math.max(timeoutS, 0), 3600) * 1_000;

    const baselineIds = new Set(this.session.comments.map((c) => c.id));
    const result = (reason: WaitReason): WaitResult => ({
      reason,
      review_state: this.session.review_state,
      generation: this.session.generation,
      new_comments: this.session.comments.filter((c) => !baselineIds.has(c.id)),
    });

    if (this.session.review_state === "submitted") {
      return Promise.resolve(json(result("submitted")));
    }

    return new Promise<Response>((resolve) => {
      let done = false;
      const finish = (reason: WaitReason) => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        this.lastActivity = Date.now();
        resolve(json(result(reason)));
      };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      const unsubscribe = this.hub.onEvent((event) => {
        if (event === "review.submitted") finish("submitted");
        else if (event === "comment.created") finish("new-comments");
      });
    });
  }
}

// ---------------------------------------------------------------------------

function filesSignature(files: ManifestFile[]): string {
  return JSON.stringify(files);
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
