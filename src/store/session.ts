/**
 * Session persistence. Every mutation goes through `save()` which writes
 * atomically (temp file + rename) — a crash never corrupts or loses state.
 *
 * Schema v2 (revision / five-state comment lifecycle). v1 sessions on disk
 * are migrated leniently on load rather than discarded — state is a local
 * cache, but comments are the one thing prediff promises never to lose:
 *   generation → revision, review_state reviewing|submitted → session_state
 *   reviewing|ready, comment open → submitted, outdated → orphaned.
 */

import {
  SCHEMA_VERSION,
  type CommentReply,
  type CommentTag,
  type FeedbackBatch,
  type ReviewComment,
  type Session,
  type Side,
} from "../types";
import { readJson, writeJsonAtomic } from "./atomic";
import { currentSessionPath, sessionPath } from "./paths";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export interface NewCommentInput {
  file: string;
  line: number;
  end_line?: number;
  side?: Side;
  text: string;
  tag?: CommentTag | null;
}

export class SessionStore {
  constructor(readonly stateDir: string) {}

  async load(sessionId: string): Promise<Session | null> {
    const raw = await readJson<Record<string, unknown>>(sessionPath(this.stateDir, sessionId));
    return raw ? migrateSession(raw) : null;
  }

  async loadCurrent(): Promise<Session | null> {
    const cur = await readJson<{ session_id: string }>(currentSessionPath(this.stateDir));
    if (!cur) return null;
    return this.load(cur.session_id);
  }

  async save(session: Session): Promise<void> {
    session.updated_at = new Date().toISOString();
    await writeJsonAtomic(sessionPath(this.stateDir, session.session_id), session);
  }

  async setCurrent(sessionId: string): Promise<void> {
    await writeJsonAtomic(currentSessionPath(this.stateDir), { session_id: sessionId });
  }

  async create(
    repoRoot: string,
    range: string,
    scope: string | null = null,
    scopeFiles: string[] | null = null,
  ): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      schema_version: SCHEMA_VERSION,
      session_id: newId("sess"),
      repo_root: repoRoot,
      range,
      revision: 1,
      session_state: "reviewing",
      scope,
      scope_files: scopeFiles,
      viewed_files: [],
      comments: [],
      feedback_batches: [],
      created_at: now,
      updated_at: now,
    };
    await this.save(session);
    await this.setCurrent(session.session_id);
    return session;
  }
}

// ---------------------------------------------------------------------------
// v1 → v2 migration (lenient; idempotent on v2 input)

const V1_COMMENT_STATE: Record<string, ReviewComment["state"]> = {
  open: "submitted",
  outdated: "orphaned",
  resolved: "resolved",
};

export function migrateSession(raw: Record<string, unknown>): Session {
  if (raw["schema_version"] === SCHEMA_VERSION) {
    const session = raw as unknown as Session;
    // Additive v2 field: sessions written before scope_files existed.
    session.scope_files = normalizeScopeFiles(raw["scope_files"]);
    return session;
  }

  const now = new Date().toISOString();
  const v1State = raw["review_state"];
  const comments = Array.isArray(raw["comments"]) ? (raw["comments"] as Record<string, unknown>[]) : [];
  const session: Session = {
    schema_version: SCHEMA_VERSION,
    session_id: String(raw["session_id"] ?? newId("sess")),
    repo_root: String(raw["repo_root"] ?? ""),
    range: String(raw["range"] ?? "working"),
    revision: typeof raw["generation"] === "number" ? raw["generation"] : 1,
    session_state: v1State === "submitted" ? "ready" : "reviewing",
    scope: typeof raw["scope"] === "string" ? raw["scope"] : null,
    scope_files: normalizeScopeFiles(raw["scope_files"]),
    viewed_files: Array.isArray(raw["viewed_files"]) ? (raw["viewed_files"] as string[]) : [],
    comments: comments.map(migrateComment),
    feedback_batches: [],
    created_at: String(raw["created_at"] ?? now),
    updated_at: String(raw["updated_at"] ?? now),
  };
  if (typeof raw["submitted_at"] === "string") session.ready_at = raw["submitted_at"];
  return session;
}

function normalizeScopeFiles(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((p) => typeof p === "string")
    ? (value as string[])
    : null;
}

function migrateComment(raw: Record<string, unknown>): ReviewComment {
  const state = V1_COMMENT_STATE[String(raw["state"])] ?? "submitted";
  const c = raw as unknown as ReviewComment;
  return {
    ...c,
    state,
    tag: (raw["tag"] as CommentTag | undefined) ?? null,
    revision: typeof raw["generation"] === "number" ? raw["generation"] : (c.revision ?? 1),
    batch_id: typeof raw["batch_id"] === "string" ? raw["batch_id"] : null,
  };
}

// ---------------------------------------------------------------------------
// Pure session mutations (callers persist via store.save afterwards)

export function addComment(
  session: Session,
  input: NewCommentInput,
  anchorLines: { context_before: string[]; lines: string[]; context_after: string[] },
): ReviewComment {
  const now = new Date().toISOString();
  const comment: ReviewComment = {
    id: newId("c"),
    file: input.file,
    line: input.line,
    end_line: input.end_line ?? input.line,
    side: input.side ?? "new",
    text: input.text,
    state: "draft",
    tag: input.tag ?? null,
    revision: session.revision,
    anchor: anchorLines,
    replies: [],
    batch_id: null,
    created_at: now,
    updated_at: now,
  };
  session.comments.push(comment);
  return comment;
}

export function findComment(session: Session, id: string): ReviewComment | null {
  return session.comments.find((c) => c.id === id) ?? null;
}

/**
 * Flip the given draft comments to `submitted` as one feedback batch
 * (spec §5.1). Returns the recorded batch. Caller checks non-empty.
 */
export function submitComments(session: Session, drafts: ReviewComment[]): FeedbackBatch {
  const now = new Date().toISOString();
  const batch: FeedbackBatch = {
    id: newId("fb"),
    sent_at: now,
    comment_ids: drafts.map((c) => c.id),
  };
  for (const comment of drafts) {
    comment.state = "submitted";
    comment.batch_id = batch.id;
    comment.submitted_at = now;
    comment.updated_at = now;
  }
  session.feedback_batches.push(batch);
  // New feedback means the developer expects another agent turn.
  if (session.session_state === "ready") {
    session.session_state = "reviewing";
    delete session.ready_at;
  }
  return batch;
}

export function resolveComment(
  session: Session,
  id: string,
  reply?: { from: CommentReply["from"]; text: string },
): ReviewComment | null {
  const comment = findComment(session, id);
  if (!comment) return null;
  comment.state = "resolved";
  comment.updated_at = new Date().toISOString();
  if (reply) {
    comment.replies.push({ ...reply, created_at: comment.updated_at });
  }
  return comment;
}

export function addReply(
  session: Session,
  id: string,
  reply: { from: CommentReply["from"]; text: string },
): ReviewComment | null {
  const comment = findComment(session, id);
  if (!comment) return null;
  comment.updated_at = new Date().toISOString();
  comment.replies.push({ ...reply, created_at: comment.updated_at });
  return comment;
}

export function deleteComment(session: Session, id: string): boolean {
  const idx = session.comments.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  session.comments.splice(idx, 1);
  return true;
}

/** Set/unset a file's viewed flag; returns true when the set changed. */
export function setViewed(session: Session, file: string, viewed: boolean): boolean {
  const has = session.viewed_files.includes(file);
  if (viewed && !has) {
    session.viewed_files.push(file);
    return true;
  }
  if (!viewed && has) {
    session.viewed_files = session.viewed_files.filter((f) => f !== file);
    return true;
  }
  return false;
}

export function commentCounts(session: Session) {
  const counts = { total: 0, draft: 0, submitted: 0, addressed: 0, resolved: 0, orphaned: 0 };
  for (const c of session.comments) {
    counts.total++;
    counts[c.state]++;
  }
  return counts;
}
