import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./DiffViewer.tsx", import.meta.url), "utf8");

describe("Diff review pointer gestures", () => {
  test("keeps native text selection separate from range comments", () => {
    expect(source).toContain("enableGutterUtility: interdiff === null");
    expect(source).toContain("onGutterUtilityClick:");
    expect(source).not.toContain("enableLineSelection:");
    expect(source).not.toContain("onLineSelectionEnd:");
  });

  test("uses Diffs' native GitHub-style context expansion", () => {
    expect(source).toContain('hunkSeparators: "line-info"');
    expect(source).toContain("expandUnchanged: false");
    expect(source).toContain("expansionLineCount: 20");
  });

  test("reserves a viewport for anchoring files collapsed near the end", () => {
    expect(source).toContain("paddingBottom: viewportHeight");
    expect(source).toContain("containerRef={containerRef}");
  });

  test("updates draft content without replacing the Diffs annotation portal", () => {
    expect(source).toContain("commentId: comment.id");
    expect(source).toContain(
      "state.comments.find((item) => item.id === commentId)",
    );
    const signature = source.match(
      /function commentSignature[\s\S]*?return \[([\s\S]*?)\]\.join/,
    )?.[1];
    expect(signature).toBeDefined();
    expect(signature).not.toContain("comment.text");
    expect(signature).not.toContain("comment.tag");
    expect(signature).not.toContain("comment.suggestion");
    expect(signature).not.toContain("comment.replies");
  });
});
