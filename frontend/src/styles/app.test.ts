import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("Diffs annotation layout contract", () => {
  test("CodeView owns the scroll area used by sticky headers and context expansion", () => {
    const rule = declarations(".pierre-code-view");

    expect(rule).toContain("overflow: auto");
  });

  test("comment annotations remain measurable normal-flow boxes", () => {
    const rule = declarations(".row-thread,\n.row-composer");

    expect(rule).toContain("min-width: 0");
    expect(rule).toContain("overflow: hidden");
    expect(rule).not.toContain("position: sticky");
  });

  test("comment editors cannot resize outside the annotation lifecycle", () => {
    const rule = declarations(".row-thread textarea,\n.row-composer textarea");

    expect(rule).toContain("resize: none");
  });
});
