import type { ReactElement } from "react";
import { memo, useEffect, useRef, useState } from "react";
import type { FileStatus } from "../types";
import { selectTree, type TreeItem } from "../state/selectors";
import {
  markCollapsedViewed,
  setFilterQuery,
  setTreeWidth,
  toggleFile,
  toggleViewed,
  useStore,
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

const FileItem = memo(function FileItem({
  item,
  active,
  dim,
}: {
  item: TreeItem;
  active: boolean;
  dim: boolean;
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
        <span>{item.file.path}</span>
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

export function FileTree(): ReactElement {
  const tree = useStore(selectTree);
  const width = useStore((s) => s.treeWidth);
  const filterQuery = useStore((s) => s.filterQuery);
  const activePath = useStore((s) => s.activePath);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    registerFilterInput(inputRef.current);
    return () => registerFilterInput(null);
  }, []);

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
        {tree.active.map((item) => (
          <FileItem
            key={item.file.path}
            item={item}
            active={item.file.path === activePath}
            dim={false}
          />
        ))}
        {tree.active.length === 0 && <div className="sb-empty">No files match the filter.</div>}
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
