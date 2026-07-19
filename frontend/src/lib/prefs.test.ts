import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearPref, readPref, writePref } from "./prefs";

/** Minimal localStorage stand-in (bun test has no DOM). */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const g = globalThis as { localStorage?: Storage };
let saved: Storage | undefined;

beforeEach(() => {
  saved = g.localStorage;
  g.localStorage = makeStorage();
});

afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
});

describe("prefs", () => {
  test("readPref returns the fallback when nothing is stored", () => {
    expect(readPref("wrapLines", true)).toBe(true);
    expect(readPref("wrapLines", false)).toBe(false);
    expect(readPref<string>("viewMode", "split")).toBe("split");
  });

  test("writePref → readPref round-trips JSON values", () => {
    writePref("wrapLines", false);
    expect(readPref("wrapLines", true)).toBe(false);
    writePref("wrapLines", true);
    expect(readPref("wrapLines", false)).toBe(true);
    writePref("treeWidth", 320);
    expect(readPref("treeWidth", 280)).toBe(320);
  });

  test("keys are namespaced under prediff.", () => {
    writePref("wrapLines", false);
    expect(localStorage.getItem("prediff.wrapLines")).toBe("false");
  });

  test("malformed stored JSON falls back instead of throwing", () => {
    localStorage.setItem("prediff.wrapLines", "{nope");
    expect(readPref("wrapLines", true)).toBe(true);
  });

  test("clearPref removes the value", () => {
    writePref("wrapLines", false);
    clearPref("wrapLines");
    expect(readPref("wrapLines", true)).toBe(true);
  });

  test("storage failures are swallowed (private mode, quota)", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(() => writePref("wrapLines", true)).not.toThrow();
    expect(readPref("wrapLines", false)).toBe(false);
    expect(() => clearPref("wrapLines")).not.toThrow();
  });

  test("missing localStorage entirely falls back", () => {
    delete g.localStorage;
    expect(readPref("wrapLines", true)).toBe(true);
    expect(() => writePref("wrapLines", false)).not.toThrow();
  });
});
