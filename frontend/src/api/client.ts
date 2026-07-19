/** Typed client for the daemon's JSON API (same-origin). */

import type {
  CommentState,
  CommentTag,
  DiffManifest,
  FileContentResult,
  FileDiff,
  MarkReadyResult,
  ReviewComment,
  RevisionsResult,
  SendFeedbackResult,
  Session,
  Side,
} from "../types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(route, {
    ...init,
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

export interface NewCommentRequest {
  /** Null (or absent) creates a review-level comment (QA gap §1.1). */
  file?: string | null;
  /** Required for line comments; 0 = file note; omitted for review-level. */
  line?: number;
  end_line?: number;
  side?: Side;
  text: string;
  tag?: CommentTag | null;
  /** Exact replacement text for the anchored lines (line comments only). */
  suggestion?: string | null;
}

export interface CommentPatch {
  text?: string;
  tag?: CommentTag | null;
  /** Post-draft state changes only: resolve, or reopen back to submitted. */
  state?: Extract<CommentState, "resolved" | "submitted">;
}

export interface ReanchorRequest {
  line?: number;
  end_line?: number;
  side?: Side;
  file_note?: boolean;
}

const rev = (revision: number | null): string =>
  revision === null ? "" : `&revision=${revision}`;

export const api = {
  manifest: (revision: number | null = null): Promise<DiffManifest> =>
    request(`/api/diff?${rev(revision).slice(1)}`),

  fileDiff: (
    path: string,
    opts?: { force?: boolean; revision?: number | null },
  ): Promise<FileDiff> =>
    request(
      `/api/diff/file?path=${encodeURIComponent(path)}${opts?.force ? "&force=1" : ""}${rev(opts?.revision ?? null)}`,
    ),

  /** Full one-side file content, for "Expand context" (current revision only). */
  fileContent: (path: string, side: Side = "new"): Promise<FileContentResult> =>
    request(`/api/file?path=${encodeURIComponent(path)}&side=${side}`),

  session: (): Promise<Session> => request("/api/session"),

  revisions: (): Promise<RevisionsResult> => request("/api/revisions"),

  /** Comments are always created as drafts (spec §4.2). */
  createComment: (input: NewCommentRequest): Promise<ReviewComment> =>
    request("/api/comments", { method: "POST", body: JSON.stringify(input) }),

  /** Draft autosave (text/tag) and reviewer state changes. */
  updateComment: (id: string, patch: CommentPatch): Promise<ReviewComment> =>
    request(`/api/comments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteComment: (id: string): Promise<{ ok: boolean }> =>
    request(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" }),

  replyToComment: (id: string, text: string): Promise<ReviewComment> =>
    request(`/api/comments/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ text, from: "reviewer" }),
    }),

  /** "Send this comment now" — a single-comment feedback batch (spec §5.1). */
  sendComment: (id: string): Promise<ReviewComment> =>
    request(`/api/comments/${encodeURIComponent(id)}/send`, { method: "POST", body: "{}" }),

  /** Orphaned-comment triage: manual re-anchor or convert to file note (§6.4). */
  reanchorComment: (id: string, body: ReanchorRequest): Promise<ReviewComment> =>
    request(`/api/comments/${encodeURIComponent(id)}/reanchor`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** "Send Feedback": batch every draft, wake the agent (spec §5.1). */
  sendFeedback: (): Promise<SendFeedbackResult> =>
    request("/api/feedback/send", { method: "POST", body: "{}" }),

  /** "Mark Ready": session-completion signal (spec §5.2). */
  markReady: (): Promise<MarkReadyResult> =>
    request("/api/session/mark-ready", { method: "POST", body: "{}" }),

  /** Re-opening a ready session resets it to reviewing. */
  reopen: (): Promise<unknown> => request("/api/open", { method: "POST", body: "{}" }),

  setViewed: (files: string[], viewed: boolean): Promise<{ viewed_files: string[] }> =>
    request("/api/viewed", { method: "POST", body: JSON.stringify({ files, viewed }) }),

  refresh: (): Promise<{ changed: boolean; revision: number }> =>
    request("/api/refresh", { method: "POST", body: "{}" }),
};
