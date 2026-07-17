import { describe, expect, test } from "bun:test";
import type { ReviewComment } from "../types";
import { planServerEvent } from "./events";

const comment: ReviewComment = {
  id: "c1",
  file: "a.ts",
  line: 1,
  end_line: 1,
  side: "new",
  text: "hi",
  state: "open",
  generation: 1,
  anchor: { context_before: [], lines: [], context_after: [] },
  replies: [],
  created_at: "",
  updated_at: "",
};

describe("planServerEvent (SSE reducer)", () => {
  test.each(["comment.created", "comment.updated", "comment.resolved"] as const)(
    "%s upserts the embedded comment",
    (name) => {
      expect(planServerEvent(name, { comment })).toEqual({
        action: "upsert-comment",
        comment,
      });
    },
  );

  test("comment events with malformed payload fall back to full resync", () => {
    expect(planServerEvent("comment.created", { comment: { bogus: true } }).action).toBe(
      "full-resync",
    );
    expect(planServerEvent("comment.created", null).action).toBe("full-resync");
  });

  test("comment.deleted removes by id", () => {
    expect(planServerEvent("comment.deleted", { id: "c1" })).toEqual({
      action: "remove-comment",
      id: "c1",
    });
    expect(planServerEvent("comment.deleted", {}).action).toBe("full-resync");
  });

  test("review.submitted flips review state without refetching diffs", () => {
    expect(planServerEvent("review.submitted", { session_id: "s" })).toEqual({
      action: "review-submitted",
    });
  });

  test("generation triggers the soft-refresh path", () => {
    expect(planServerEvent("generation", { generation: 2 })).toEqual({
      action: "generation-bump",
    });
  });

  test("session.changed forces a full resync", () => {
    expect(planServerEvent("session.changed", { session_id: "s2" })).toEqual({
      action: "full-resync",
    });
  });
});
