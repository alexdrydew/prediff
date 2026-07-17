/**
 * Session persistence. Every mutation goes through `save()` which writes
 * atomically (temp file + rename) — a crash never corrupts or loses state.
 */

import type { CommentReply, ReviewComment, Session, Side } from "../types";
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
}

export class SessionStore {
  constructor(readonly stateDir: string) {}

  async load(sessionId: string): Promise<Session | null> {
    return readJson<Session>(sessionPath(this.stateDir, sessionId));
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

  async create(repoRoot: string, range: string): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      session_id: newId("sess"),
      repo_root: repoRoot,
      range,
      generation: 1,
      review_state: "reviewing",
      created_at: now,
      updated_at: now,
      comments: [],
    };
    await this.save(session);
    await this.setCurrent(session.session_id);
    return session;
  }

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
    state: "open",
    generation: session.generation,
    anchor: anchorLines,
    replies: [],
    created_at: now,
    updated_at: now,
  };
  session.comments.push(comment);
  return comment;
}

export function findComment(session: Session, id: string): ReviewComment | null {
  return session.comments.find((c) => c.id === id) ?? null;
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
