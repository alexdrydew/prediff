import { describe, expect, test } from "bun:test";
import { fuzzyMatch, matchesFilter, parseFilter } from "./filter";

describe("parseFilter (§7.5 typed filters)", () => {
  test("plain text is fuzzy query", () => {
    expect(parseFilter("auth py")).toEqual({ text: "auth py", filters: [], unknown: [] });
  });

  test("typed filters combine with free text", () => {
    const p = parseFilter("is:unviewed auth is:commented");
    expect(p.text).toBe("auth");
    expect(p.filters).toEqual(["unviewed", "commented"]);
  });

  test("agent-touched filter and unknown filters", () => {
    expect(parseFilter("is:agent-touched").filters).toEqual(["agent-touched"]);
    expect(parseFilter("is:bogus").unknown).toEqual(["bogus"]);
  });

  test("duplicates collapse; case-insensitive", () => {
    expect(parseFilter("IS:UNVIEWED is:unviewed").filters).toEqual(["unviewed"]);
  });
});

describe("fuzzyMatch", () => {
  test("subsequence match, case-insensitive", () => {
    expect(fuzzyMatch("src/auth.py", "auth")).toBe(true);
    expect(fuzzyMatch("src/auth.py", "SAP")).toBe(true); // s…a…p
    expect(fuzzyMatch("src/auth.py", "xyz")).toBe(false);
    expect(fuzzyMatch("src/auth.py", "")).toBe(true);
  });

  test("chars must appear in order", () => {
    expect(fuzzyMatch("abc", "cb")).toBe(false);
  });
});

describe("matchesFilter", () => {
  const info = { viewed: false, commentCount: 2, agentTouched: false };

  test("typed filters gate results", () => {
    expect(matchesFilter("a.ts", info, parseFilter("is:commented"))).toBe(true);
    expect(matchesFilter("a.ts", info, parseFilter("is:agent-touched"))).toBe(false);
    expect(matchesFilter("a.ts", { ...info, viewed: true }, parseFilter("is:unviewed"))).toBe(
      false,
    );
  });

  test("text and filters combine (AND)", () => {
    expect(matchesFilter("src/auth.py", info, parseFilter("is:commented auth"))).toBe(true);
    expect(matchesFilter("src/auth.py", info, parseFilter("is:commented zzz"))).toBe(false);
  });
});
