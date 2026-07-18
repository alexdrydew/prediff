/**
 * Maps server SSE events onto store mutations. The decision logic
 * (`planServerEvent`) is pure so it can be unit-tested without a DOM,
 * network, or the store itself.
 */

import type { ReviewComment } from "../types";
import type { ServerEventName } from "../api/sse";
import {
  handleRevisionArrived,
  loadServerState,
  removeComment,
  setAgentRevising,
  setSessionState,
  setViewedFiles,
  upsertComment,
} from "./store";

/** What an incoming event should do to local state. */
export type EventPlan =
  | { action: "upsert-comment"; comment: ReviewComment }
  | { action: "upsert-comments"; comments: ReviewComment[] }
  | { action: "remove-comment"; id: string }
  | { action: "session-ready" }
  | { action: "revision-arrived"; revision: number }
  | { action: "viewed-changed"; files: string[] }
  | { action: "full-resync" }
  | { action: "ignore"; reason: string };

function isComment(value: unknown): value is ReviewComment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { file?: unknown }).file === "string"
  );
}

export function planServerEvent(name: ServerEventName, data: unknown): EventPlan {
  switch (name) {
    case "comment.created":
    case "comment.updated":
    case "comment.resolved": {
      const comment = (data as { comment?: unknown } | null)?.comment;
      return isComment(comment)
        ? { action: "upsert-comment", comment }
        : { action: "full-resync" }; // malformed payload: reconcile from /api/session
    }
    case "comment.deleted": {
      const id = (data as { id?: unknown } | null)?.id;
      return typeof id === "string"
        ? { action: "remove-comment", id }
        : { action: "full-resync" };
    }
    case "feedback.sent": {
      const comments = (data as { comments?: unknown } | null)?.comments;
      return Array.isArray(comments) && comments.every(isComment)
        ? { action: "upsert-comments", comments }
        : { action: "full-resync" };
    }
    case "session.ready":
      return { action: "session-ready" };
    case "revision": {
      const revision = (data as { revision?: unknown } | null)?.revision;
      // The new revision is queued behind a banner — never auto-applied
      // (spec §6.1/§6.3).
      return typeof revision === "number"
        ? { action: "revision-arrived", revision }
        : { action: "full-resync" };
    }
    case "viewed.changed": {
      const files = (data as { viewed_files?: unknown } | null)?.viewed_files;
      return Array.isArray(files) && files.every((f) => typeof f === "string")
        ? { action: "viewed-changed", files }
        : { action: "full-resync" };
    }
    case "session.changed":
      return { action: "full-resync" };
  }
}

export function applyServerEvent(name: ServerEventName, data: unknown): void {
  const plan = planServerEvent(name, data);
  switch (plan.action) {
    case "upsert-comment":
      upsertComment(plan.comment);
      break;
    case "upsert-comments":
      for (const c of plan.comments) upsertComment(c);
      // A feedback batch means the agent has work to do (§6.5) — this also
      // covers batches sent from another tab or via the CLI.
      if (name === "feedback.sent") setAgentRevising(true);
      break;
    case "remove-comment":
      removeComment(plan.id);
      break;
    case "session-ready":
      setSessionState("ready");
      break;
    case "revision-arrived":
      handleRevisionArrived(plan.revision);
      break;
    case "viewed-changed":
      setViewedFiles(plan.files);
      break;
    case "full-resync":
      void loadServerState();
      break;
    case "ignore":
      break;
  }
}
