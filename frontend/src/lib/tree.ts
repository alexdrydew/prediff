/**
 * Directory grouping for the file list (QA gap §1.6): build a directory tree
 * from flat paths, compress single-child directory chains (GitHub-style),
 * flatten it for rendering (directories first, then files, both sorted), and
 * derive the flattened order the diff panel / n-p navigation must follow.
 * Pure and DOM-free for unit testing.
 */

export interface DirNode {
  /** Display name; single-child chains compress to "a/b/c". */
  name: string;
  /** Full directory path ("" for the root). */
  path: string;
  dirs: DirNode[];
  /** Full file paths directly in this directory. */
  files: string[];
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Merge single-child, file-less directory chains into one node. */
function compressChild(node: DirNode): DirNode {
  let d = node;
  while (d.files.length === 0 && d.dirs.length === 1) {
    const only = d.dirs[0]!;
    d = { name: `${d.name}/${only.name}`, path: only.path, dirs: only.dirs, files: only.files };
  }
  return { ...d, dirs: d.dirs.map(compressChild) };
}

/** Build the (compressed, sorted) directory tree over `paths`. */
export function buildTree(paths: readonly string[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [] };
  const dirIndex = new Map<string, DirNode>([["", root]]);

  const dirFor = (dirPath: string): DirNode => {
    const existing = dirIndex.get(dirPath);
    if (existing) return existing;
    const parent = dirFor(dirPath.slice(0, Math.max(0, dirPath.lastIndexOf("/"))));
    const node: DirNode = { name: basename(dirPath), path: dirPath, dirs: [], files: [] };
    parent.dirs.push(node);
    dirIndex.set(dirPath, node);
    return node;
  };

  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? root : dirFor(path.slice(0, slash));
    dir.files.push(path);
  }

  const sortNode = (node: DirNode): void => {
    node.dirs.sort(byName);
    node.files.sort((a, b) => {
      const an = basename(a);
      const bn = basename(b);
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    for (const d of node.dirs) sortNode(d);
  };
  sortNode(root);
  return { ...root, dirs: root.dirs.map(compressChild) };
}

/** Depth-first file order (directories before loose files at each level) —
 * the order the diff panel renders files in, hence the n/p nav order. */
export function flattenTreeOrder(root: DirNode): string[] {
  const out: string[] = [];
  const walk = (node: DirNode): void => {
    for (const d of node.dirs) walk(d);
    for (const f of node.files) out.push(f);
  };
  walk(root);
  return out;
}

/** Sort `items` (anything with a path) into flattened tree order. */
export function sortByTreeOrder<T extends { path: string }>(items: readonly T[]): T[] {
  const order = flattenTreeOrder(buildTree(items.map((i) => i.path)));
  const index = new Map(order.map((p, i) => [p, i]));
  return [...items].sort(
    (a, b) => (index.get(a.path) ?? 0) - (index.get(b.path) ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Sidebar rows

export type SidebarRow<T> =
  | { type: "dir"; path: string; name: string; depth: number; collapsed: boolean }
  | { type: "file"; item: T; name: string; depth: number };

/**
 * Rows the sidebar renders. Tree mode groups by directory with collapsible
 * folders (children of a collapsed dir are skipped); `flat` mode — used while
 * the filter is active — lists full paths in the given order.
 */
export function sidebarRows<T extends { path: string }>(
  items: readonly T[],
  collapsedDirs: ReadonlySet<string>,
  flat: boolean,
): SidebarRow<T>[] {
  if (flat) {
    return items.map((item) => ({ type: "file", item, name: item.path, depth: 0 }));
  }
  const byPath = new Map(items.map((i) => [i.path, i]));
  const rows: SidebarRow<T>[] = [];
  const walk = (node: DirNode, depth: number): void => {
    for (const d of node.dirs) {
      const collapsed = collapsedDirs.has(d.path);
      rows.push({ type: "dir", path: d.path, name: d.name, depth, collapsed });
      if (!collapsed) walk(d, depth + 1);
    }
    for (const f of node.files) {
      const item = byPath.get(f);
      if (item) rows.push({ type: "file", item, name: basename(f), depth });
    }
  };
  walk(buildTree(items.map((i) => i.path)), 0);
  return rows;
}
