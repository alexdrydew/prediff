/**
 * RepoWatcher: change-signature semantics and fs-event-driven change
 * detection (fs events decide WHEN to check; the signature — porcelain +
 * HEAD + dirty-file mtime/size — stays the authoritative detector).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { RepoWatcher } from "../src/server/watcher";
import { cleanup, commitAll, initRepo, write } from "./helpers";

let repo: string;

beforeAll(async () => {
  repo = await initRepo();
  await write(repo, "a.txt", "one\n");
  await write(repo, "b.txt", "two\n");
  await commitAll(repo, "base");
});

afterAll(async () => {
  await cleanup(repo);
});

/** Poll until `fn` is truthy or `timeoutMs` elapses; returns elapsed ms. */
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (fn()) return performance.now() - t0;
    await Bun.sleep(25);
  }
  return -1;
}

test("computeSignature is stable when the repo is unchanged", async () => {
  const w = new RepoWatcher(repo, () => {});
  const a = await w.computeSignature();
  const b = await w.computeSignature();
  expect(a).toBe(b);
});

test("computeSignature changes on a working-tree edit, again on a repeat edit", async () => {
  const w = new RepoWatcher(repo, () => {});
  const clean = await w.computeSignature();

  await write(repo, "a.txt", "one edited\n");
  const dirty = await w.computeSignature();
  expect(dirty).not.toBe(clean);

  // Repeat edit to the already-dirty file: porcelain output is identical,
  // only mtime/size distinguish it.
  await Bun.sleep(5); // ensure a distinct mtime
  await write(repo, "a.txt", "one edited twice\n");
  const dirtier = await w.computeSignature();
  expect(dirtier).not.toBe(dirty);

  await commitAll(repo, "edit"); // HEAD moves → signature changes again
  const committed = await w.computeSignature();
  expect(committed).not.toBe(dirtier);
  expect(committed).not.toBe(clean);
});

test("computeSignature tracks untracked files: create, edit, nested edit, delete", async () => {
  const w = new RepoWatcher(repo, () => {});
  const clean = await w.computeSignature();

  // A brand-new untracked file changes the porcelain output.
  await write(repo, "untracked.txt", "fresh\n");
  const created = await w.computeSignature();
  expect(created).not.toBe(clean);

  // Editing it leaves porcelain identical; mtime/size must catch it.
  await Bun.sleep(5);
  await write(repo, "untracked.txt", "fresh edited\n");
  const edited = await w.computeSignature();
  expect(edited).not.toBe(created);

  // A file inside an untracked directory: porcelain -uall lists it
  // individually (plain porcelain shows only "?? dir/", whose stat doesn't
  // change on an in-place edit of a contained file).
  await write(repo, "untracked-dir/inner.txt", "a\n");
  const nested = await w.computeSignature();
  expect(nested).not.toBe(edited);
  await Bun.sleep(5);
  await write(repo, "untracked-dir/inner.txt", "b\n"); // same size, new mtime
  const nestedEdited = await w.computeSignature();
  expect(nestedEdited).not.toBe(nested);

  // Deleting untracked files restores the clean signature shape.
  await fs.rm(path.join(repo, "untracked.txt"));
  await fs.rm(path.join(repo, "untracked-dir"), { recursive: true });
  const deleted = await w.computeSignature();
  expect(deleted).not.toBe(nestedEdited);
  expect(deleted).toBe(clean);
});

test("watcher fires quickly on a file change (fs-event path) and stays quiet otherwise", async () => {
  let fired = 0;
  const w = new RepoWatcher(repo, () => fired++);
  w.start();
  try {
    // Let the initial baseline check land.
    await Bun.sleep(400);
    expect(fired).toBe(0);

    // Quiet repo → no callbacks.
    await Bun.sleep(1_200);
    expect(fired).toBe(0);

    await write(repo, "b.txt", "two edited\n");
    // fs event + settle (100ms) + check + debounce (250ms) ≪ safety poll (7s):
    // a fast detection proves the event path, not the poll.
    const elapsed = await waitFor(() => fired > 0, 5_000);
    expect(elapsed).toBeGreaterThan(-1);
    expect(elapsed).toBeLessThan(4_000);

    // Repeat edit to the same (already-dirty) file is still detected.
    const before = fired;
    await Bun.sleep(5);
    await write(repo, "b.txt", "two edited again\n");
    expect(await waitFor(() => fired > before, 5_000)).toBeGreaterThan(-1);
  } finally {
    w.stop();
  }
}, 20_000);

test("watcher fires when an untracked file appears, and again when it's edited", async () => {
  let fired = 0;
  const w = new RepoWatcher(repo, () => fired++);
  w.start();
  try {
    await Bun.sleep(400); // baseline check
    expect(fired).toBe(0);

    await write(repo, "agent-created.txt", "brand new\n");
    expect(await waitFor(() => fired > 0, 5_000)).toBeGreaterThan(-1);

    const before = fired;
    await Bun.sleep(5);
    await write(repo, "agent-created.txt", "brand new, edited\n");
    expect(await waitFor(() => fired > before, 5_000)).toBeGreaterThan(-1);
  } finally {
    w.stop();
    await fs.rm(path.join(repo, "agent-created.txt"), { force: true });
  }
}, 20_000);
