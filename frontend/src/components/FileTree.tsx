import type { ReactElement } from "react";
import { memo, useEffect, useRef, useState } from "react";
import type { FileStatus } from "../types";
import { selectTree, type TreeItem } from "../state/selectors";
import {
  markCollapsedViewed,
  setFilterQuery,
  setTreeWidth,
  toggleDir,
  toggleFile,
  toggleViewed,
  useStore,
  type InterdiffState,
} from "../state/store";
import { registerFilterInput, scrollToPath } from "../state/controller";

const STATUS_IC: Record<FileStatus, { ch: string; cls: string }> = {
  added: { ch: "A", cls: "a" },
  deleted: { ch: "D", cls: "d" },
  modified: { ch: "M", cls: "m" },
  renamed: { ch: "R", cls: "r" },
  copied: { ch: "C", cls: "r" },
  "type-changed": { ch: "T", cls: "m" },
  unmerged: { ch: "U", cls: "d" },
};

/** Indent per nesting level, on the token spacing scale (--space-3). */
const INDENT_PX = 12;

const FileItem = memo(function FileItem({
  item,
  active,
  dim,
  name,
  depth = 0,
}: {
  item: TreeItem;
  active: boolean;
  dim: boolean;
  /** Display name: basename inside the tree, full path in flat lists. */
  name?: string;
  depth?: number;
}): ReactElement {
  const ic = STATUS_IC[item.file.status];
  const ref = useRef<HTMLDivElement>(null);

  // Tree follows the diff panel's scroll position (§7.2).
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={ref}
      className={`sb-item${active ? " active" : ""}${dim ? " dim" : ""}`}
      role="button"
      tabIndex={0}
      style={depth > 0 ? { paddingLeft: 14 + depth * INDENT_PX } : undefined}
      onClick={() => {
        if (!item.expanded) toggleFile(item.file.path);
        scrollToPath(item.file.path);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") scrollToPath(item.file.path);
      }}
      title={item.file.path}
    >
      <button
        className={`sb-chk${item.viewed ? " on" : ""}`}
        aria-label={item.viewed ? "Mark not viewed" : "Mark viewed"}
        title="Viewed"
        onClick={(e) => {
          e.stopPropagation();
          void toggleViewed(item.file.path);
        }}
      />
      <span className={`sb-ic ${ic.cls}`}>{ic.ch}</span>
      <span className="sb-name">
        <span>{name ?? item.file.path}</span>
      </span>
      {item.scopeFlag !== null && (
        <span className="sb-scope" title={item.scopeFlag}>
          ⚠
        </span>
      )}
      {item.commentCount > 0 && (
        <span
          className="sb-cmnt"
          title={`${item.unresolvedCount} unresolved of ${item.commentCount} comments`}
        >
          {item.unresolvedCount > 0 ? item.unresolvedCount : item.commentCount}
        </span>
      )}
      <span className="sb-stats">
        {item.file.additions > 0 && <span className="sa">+{item.file.additions}</span>}
        {item.file.deletions > 0 && <span className="sd">-{item.file.deletions}</span>}
      </span>
      {item.agentTouched && (
        <span className="sb-dot" title="Agent touched this file since your last look" />
      )}
    </div>
  );
});

/** Sidebar contents while the interdiff comparison view is active (§1.4). */
function InterdiffList({ mode }: { mode: InterdiffState }): ReactElement {
  const activePath = useStore((s) => s.activePath);
  return (
    <div className="sb-list">
      <div className="sb-label">
        Changed · Rev {mode.from} → {mode.to}
      </div>
      {mode.manifest === null && (
        <div className="sb-empty">{mode.status === "error" ? "Failed to load." : "Loading…"}</div>
      )}
      {mode.manifest?.files.map((f) => (
        <div
          key={f.path}
          className={`sb-item${f.path === activePath ? " active" : ""}${f.available ? "" : " dim"}`}
          role="button"
          tabIndex={0}
          onClick={() => scrollToPath(f.path)}
          onKeyDown={(e) => {
            if (e.key === "Enter") scrollToPath(f.path);
          }}
          title={
            f.available
              ? f.path
              : `${f.path} — interdiff not available: ${f.reason ?? "content not recorded"}`
          }
        >
          <span className="sb-name">
            <span>{f.path}</span>
          </span>
          {!f.available && <span className="badge badge-muted">n/a</span>}
          <span className="sb-stats">
            {f.additions > 0 && <span className="sa">+{f.additions}</span>}
            {f.deletions > 0 && <span className="sd">-{f.deletions}</span>}
          </span>
        </div>
      ))}
      {mode.manifest !== null && mode.manifest.files.length === 0 && (
        <div className="sb-empty">
          No content changes between Rev {mode.from} and Rev {mode.to}.
        </div>
      )}
    </div>
  );
}

export function FileTree(): ReactElement {
  const tree = useStore(selectTree);
  const width = useStore((s) => s.treeWidth);
  const filterQuery = useStore((s) => s.filterQuery);
  const activePath = useStore((s) => s.activePath);
  const interdiff = useStore((s) => s.interdiff);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Re-register when the input remounts (it is absent in interdiff mode).
  const interdiffActive = interdiff !== null;
  useEffect(() => {
    registerFilterInput(inputRef.current);
    return () => registerFilterInput(null);
  }, [interdiffActive]);

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: MouseEvent): void => setTreeWidth(ev.clientX);
    const up = (): void => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (interdiff !== null) {
    return (
      <div className="sb" style={{ width }}>
        <InterdiffList mode={interdiff} />
        <div
          className={`sb-resize${dragging ? " dragging" : ""}`}
          onMouseDown={startResize}
          title="Drag to resize"
        />
      </div>
    );
  }

  return (
    <div className="sb" style={{ width }}>
      <div className="sb-search">
        <span className="search-ic">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className="sb-input"
          placeholder="Filter files…  is:unviewed is:commented"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilterQuery("");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <kbd>/</kbd>
      </div>
      <div className="sb-list">
        <div className="sb-label">Changed files</div>
        {tree.rows.map((row) =>
          row.type === "dir" ? (
            <div
              key={`d:${row.path}`}
              className="sb-dir"
              role="button"
              tabIndex={0}
              style={row.depth > 0 ? { paddingLeft: 14 + row.depth * INDENT_PX } : undefined}
              title={row.path}
              onClick={() => toggleDir(row.path)}
              onKeyDown={(e) => {
                if (e.key === "Enter") toggleDir(row.path);
              }}
            >
              <span className="twisty">{row.collapsed ? "▸" : "▾"}</span>
              <span className="sb-dir-name">{row.name}/</span>
            </div>
          ) : (
            <FileItem
              key={row.item.file.path}
              item={row.item}
              active={row.item.file.path === activePath}
              dim={false}
              name={row.name}
              depth={row.depth}
            />
          ),
        )}
        {tree.rows.length === 0 && <div className="sb-empty">No files match the filter.</div>}
        {tree.collapsed.length > 0 && (
          <>
            <div className="sb-label">
              Auto-collapsed
              <button
                onClick={() => void markCollapsedViewed()}
                title="Acknowledge generated/collapsed files without reviewing line-by-line (§7.5)"
              >
                mark all viewed
              </button>
            </div>
            {tree.collapsed.map((item) => (
              <FileItem
                key={item.file.path}
                item={item}
                active={item.file.path === activePath}
                dim
              />
            ))}
          </>
        )}
      </div>
      <div
        className={`sb-resize${dragging ? " dragging" : ""}`}
        onMouseDown={startResize}
        title="Drag to resize"
      />
    </div>
  );
}
