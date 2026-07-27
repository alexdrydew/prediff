import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { store, toggleViewed } from "./store";

const originalFetch = globalThis.fetch;
const path = "src/example.ts";

function mockFetch(handler: () => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: originalFetch.preconnect });
}

beforeEach(() => {
  globalThis.fetch = mockFetch(async () =>
    new Response(JSON.stringify({ viewed_files: [path] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  store.setState({
    viewedFiles: new Set<string>(),
    collapsedOverride: {},
    agentTouched: new Set<string>([path]),
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("toggleViewed", () => {
  test("marking a file viewed also collapses it", async () => {
    await toggleViewed(path, true);

    expect(store.getState().viewedFiles.has(path)).toBeTrue();
    expect(store.getState().collapsedOverride[path]).toBeTrue();
    expect(store.getState().agentTouched.has(path)).toBeFalse();
  });

  test("marking a file not viewed does not expand it", async () => {
    store.setState({
      viewedFiles: new Set<string>([path]),
      collapsedOverride: { [path]: true },
    });

    await toggleViewed(path, false);

    expect(store.getState().viewedFiles.has(path)).toBeFalse();
    expect(store.getState().collapsedOverride[path]).toBeTrue();
  });

  test("a failed viewed update restores the previous collapse state", async () => {
    globalThis.fetch = mockFetch(async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await toggleViewed(path, true);

    expect(store.getState().viewedFiles.has(path)).toBeFalse();
    expect(store.getState().collapsedOverride[path]).toBeUndefined();
  });
});
