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
  state: "draft",
  tag: null,
  revision: 1,
  anchor: { context_before: [], lines: [], context_after: [] },
  replies: [],
  batch_id: null,
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

  test("feedback.sent upserts the batch's comments", () => {
    expect(planServerEvent("feedback.sent", { batch: { id: "b1" }, comments: [comment] })).toEqual(
      { action: "upsert-comments", comments: [comment] },
    );
    expect(planServerEvent("feedback.sent", { comments: "nope" }).action).toBe("full-resync");
  });

  test("session.ready flips session state without refetching diffs", () => {
    expect(planServerEvent("session.ready", { session_id: "s" })).toEqual({
      action: "session-ready",
    });
  });

  test("revision queues the new revision — never auto-applies (§6.1)", () => {
    expect(planServerEvent("revision", { revision: 3, files: 2 })).toEqual({
      action: "revision-arrived",
      revision: 3,
    });
    expect(planServerEvent("revision", {}).action).toBe("full-resync");
  });

  test("viewed.changed replaces the viewed set", () => {
    expect(planServerEvent("viewed.changed", { viewed_files: ["a.ts"] })).toEqual({
      action: "viewed-changed",
      files: ["a.ts"],
    });
    expect(planServerEvent("viewed.changed", { viewed_files: [1] }).action).toBe("full-resync");
  });

  test("session.changed forces a full resync", () => {
    expect(planServerEvent("session.changed", { session_id: "s2" })).toEqual({
      action: "full-resync",
    });
  });
});
