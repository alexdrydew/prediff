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
});
