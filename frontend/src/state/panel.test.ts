/**
 * Regression test for QA F3 (first "Mark Ready" click after a fresh page
 * load appearing swallowed): the action buttons must OPEN their confirmation
 * panel idempotently — a duplicated/replayed click, or any prior UI state,
 * must never toggle the panel straight back closed. Only explicit close
 * paths (Cancel, Esc, scrim, closePanel) dismiss it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { closePanel, openPanel, setPanel, store } from "./store";

beforeEach(() => {
  store.setState({ panel: "none", session: null });
});

describe("openPanel (Mark Ready / Send Feedback click handler)", () => {
  test("opens the confirmation on the very first invocation, with no prior state", () => {
    // Fresh-load conditions: no session loaded yet, nothing focused/opened.
    expect(store.getState().session).toBeNull();
    openPanel("ready");
    expect(store.getState().panel).toBe("ready");
  });

  test("a duplicated click keeps the panel open instead of cancelling it", () => {
    openPanel("ready");
    openPanel("ready"); // double-fired / replayed click
    expect(store.getState().panel).toBe("ready");
  });

  test("does not depend on which panel was open before", () => {
    openPanel("send");
    openPanel("ready");
    expect(store.getState().panel).toBe("ready");
  });

  test("explicit close still works", () => {
    openPanel("ready");
    closePanel();
    expect(store.getState().panel).toBe("none");
  });
});

describe("setPanel (informational panels keep toggle semantics)", () => {
  test("same panel toggles closed", () => {
    setPanel("shortcuts");
    expect(store.getState().panel).toBe("shortcuts");
    setPanel("shortcuts");
    expect(store.getState().panel).toBe("none");
  });
});
