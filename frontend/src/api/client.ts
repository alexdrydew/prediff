/** Typed client for the daemon's JSON API (same-origin). */

import type { DiffManifest, FileDiff, ReviewComment, Session, Side } from "../types";

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
  file: string;
  line: number;
  end_line?: number;
  side: Side;
  text: string;
}

export const api = {
  manifest: (): Promise<DiffManifest> => request("/api/diff"),

  fileDiff: (path: string, opts?: { force?: boolean }): Promise<FileDiff> =>
    request(`/api/diff/file?path=${encodeURIComponent(path)}${opts?.force ? "&force=1" : ""}`),

  session: (): Promise<Session> => request("/api/session"),

  createComment: (input: NewCommentRequest): Promise<ReviewComment> =>
    request("/api/comments", { method: "POST", body: JSON.stringify(input) }),

  updateComment: (id: string, patch: { text?: string; state?: "open" | "resolved" }): Promise<ReviewComment> =>
    request(`/api/comments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteComment: (id: string): Promise<{ ok: boolean }> =>
    request(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" }),

  resolveComment: (id: string, reply?: string): Promise<ReviewComment> =>
    request(`/api/comments/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify(reply !== undefined ? { reply } : {}),
    }),

  replyToComment: (id: string, text: string): Promise<ReviewComment> =>
    request(`/api/comments/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ text, from: "reviewer" }),
    }),

  submitReview: (): Promise<{ ok: boolean; review_state: string }> =>
    request("/api/review/submit", { method: "POST", body: "{}" }),

  refresh: (): Promise<{ changed: boolean; generation: number }> =>
    request("/api/refresh", { method: "POST", body: "{}" }),
};
