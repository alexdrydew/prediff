import { describe, expect, test } from "bun:test";
import { buildTree, flattenTreeOrder, sidebarRows, sortByTreeOrder } from "./tree";

const PATHS = [
  "README.md",
  "src/routes/shorten.ts",
  "src/codes.ts",
  "src/validate.ts",
  "src/routes/stats.ts",
  "tests/codes.test.ts",
];

describe("buildTree", () => {
  test("groups files by directory, sorted dirs-then-files", () => {
    const root = buildTree(PATHS);
    expect(root.dirs.map((d) => d.name)).toEqual(["src", "tests/codes.test.ts".split("/")[0]!]);
    expect(root.files).toEqual(["README.md"]);
    const src = root.dirs[0]!;
    expect(src.dirs.map((d) => d.name)).toEqual(["routes"]);
    expect(src.files).toEqual(["src/codes.ts", "src/validate.ts"]);
  });

  test("compresses single-child directory chains", () => {
    const root = buildTree(["a/b/c/deep.ts", "a/b/c/deeper.ts", "top.ts"]);
    expect(root.dirs).toHaveLength(1);
    expect(root.dirs[0]).toMatchObject({ name: "a/b/c", path: "a/b/c" });
    expect(root.dirs[0]!.files).toEqual(["a/b/c/deep.ts", "a/b/c/deeper.ts"]);
  });

  test("chain compression stops at a directory with files", () => {
    const root = buildTree(["a/file.ts", "a/b/nested.ts"]);
    expect(root.dirs[0]).toMatchObject({ name: "a" });
    expect(root.dirs[0]!.dirs[0]).toMatchObject({ name: "b" });
  });
});

describe("flattened tree order (n/p nav order)", () => {
  test("depth-first, directories before loose files", () => {
    expect(flattenTreeOrder(buildTree(PATHS))).toEqual([
      "src/routes/shorten.ts",
      "src/routes/stats.ts",
      "src/codes.ts",
      "src/validate.ts",
      "tests/codes.test.ts",
      "README.md",
    ]);
  });

  test("sortByTreeOrder reorders manifest-style items to match", () => {
    const items = PATHS.map((path) => ({ path }));
    expect(sortByTreeOrder(items).map((i) => i.path)).toEqual(
      flattenTreeOrder(buildTree(PATHS)),
    );
  });
});

describe("sidebarRows", () => {
  test("tree mode nests with depths and basenames", () => {
    const rows = sidebarRows(PATHS.map((path) => ({ path })), new Set(), false);
    expect(
      rows.map((r) => (r.type === "dir" ? `${"  ".repeat(r.depth)}${r.name}/` : `${"  ".repeat(r.depth)}${r.name}`)),
    ).toEqual([
      "src/",
      "  routes/",
      "    shorten.ts",
      "    stats.ts",
      "  codes.ts",
      "  validate.ts",
      "tests/",
      "  codes.test.ts",
      "README.md",
    ]);
  });

  test("file order in the sidebar equals the flattened nav order", () => {
    const rows = sidebarRows(PATHS.map((path) => ({ path })), new Set(), false);
    const fileOrder = rows.filter((r) => r.type === "file").map((r) => r.item.path);
    expect(fileOrder).toEqual(flattenTreeOrder(buildTree(PATHS)));
  });

  test("collapsed directory hides its descendants but stays listed", () => {
    const rows = sidebarRows(PATHS.map((path) => ({ path })), new Set(["src/routes"]), false);
    const labels = rows.map((r) => (r.type === "dir" ? `${r.name}/` : r.name));
    expect(labels).toEqual(["src/", "routes/", "codes.ts", "validate.ts", "tests/", "codes.test.ts", "README.md"]);
    expect(rows.find((r) => r.type === "dir" && r.path === "src/routes")).toMatchObject({
      collapsed: true,
    });
  });

  test("flat mode (filter active) lists full paths in the given order", () => {
    const items = ["src/codes.ts", "tests/codes.test.ts"].map((path) => ({ path }));
    const rows = sidebarRows(items, new Set(["src"]), true);
    expect(rows).toEqual([
      { type: "file", item: items[0]!, name: "src/codes.ts", depth: 0 },
      { type: "file", item: items[1]!, name: "tests/codes.test.ts", depth: 0 },
    ]);
  });
});
