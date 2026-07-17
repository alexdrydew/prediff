/**
 * Maps server SSE events onto store mutations. The decision logic
 * (`planServerEvent`) is pure so it can be unit-tested without a DOM,
 * network, or the store itself.
 */

import type { ReviewComment } from "../types";
import type { ServerEventName } from "../api/sse";
import {
  handleGenerationBump,
  loadServerState,
  removeComment,
  setReviewState,
  upsertComment,
} from "./store";

/** What an incoming event should do to local state. */
export type EventPlan =
  | { action: "upsert-comment"; comment: ReviewComment }
  | { action: "remove-comment"; id: string }
  | { action: "review-submitted" }
  | { action: "generation-bump" }
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
    case "review.submitted":
      return { action: "review-submitted" };
    case "generation":
      return { action: "generation-bump" };
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
    case "remove-comment":
      removeComment(plan.id);
      break;
    case "review-submitted":
      setReviewState("submitted");
      break;
    case "generation-bump":
      void handleGenerationBump();
      break;
    case "full-resync":
      void loadServerState();
      break;
    case "ignore":
      break;
  }
}
