import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerDiffController,
  toggleViewedKeepingPosition,
  type DiffController,
} from "./controller";
import { store } from "./store";

const originalFetch = globalThis.fetch;
const originalAnimationFrame = globalThis.requestAnimationFrame;
const path = "src/large.ts";
let scrolled: string[];

function mockFetch(handler: () => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: originalFetch.preconnect });
}

beforeEach(() => {
  scrolled = [];
  globalThis.fetch = mockFetch(async () =>
    new Response(JSON.stringify({ viewed_files: [path] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  store.setState({
    viewedFiles: new Set<string>(),
    collapsedOverride: {},
    agentTouched: new Set<string>(),
  });
  registerDiffController({
    scrollToItem: (target) => scrolled.push(target),
    scrollToLine: () => {},
    scrollToTop: () => {},
    clearSelection: () => {},
  } satisfies DiffController);
});

afterEach(() => {
  registerDiffController(null);
  globalThis.fetch = originalFetch;
  globalThis.requestAnimationFrame = originalAnimationFrame;
});

describe("toggleViewedKeepingPosition", () => {
  test("anchors the collapsed file after marking it viewed", async () => {
    await toggleViewedKeepingPosition(path, true);

    expect(store.getState().viewedFiles.has(path)).toBeTrue();
    expect(store.getState().collapsedOverride[path]).toBeTrue();
    expect(scrolled).toEqual([path]);
  });

  test("does not move the viewport when marking a file not viewed", async () => {
    store.setState({
      viewedFiles: new Set<string>([path]),
      collapsedOverride: { [path]: true },
    });

    await toggleViewedKeepingPosition(path, false);

    expect(store.getState().viewedFiles.has(path)).toBeFalse();
    expect(scrolled).toEqual([]);
  });
});
