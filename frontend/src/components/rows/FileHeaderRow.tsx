import type { ReactElement } from "react";
import { memo } from "react";
import type { ManifestFile } from "../../types";
import { toggleFile, toggleViewed } from "../../state/store";

const STATUS_LABEL: Record<ManifestFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
  "type-changed": "type changed",
  unmerged: "unmerged",
};

export const FileHeaderRow = memo(function FileHeaderRow({
  file,
  expanded,
  viewed,
  commentCount,
  unresolvedCount,
}: {
  file: ManifestFile;
  expanded: boolean;
  viewed: boolean;
  commentCount: number;
  unresolvedCount: number;
}): ReactElement {
  return (
    <div className="row-file" onClick={() => toggleFile(file.path)}>
      <span className="twisty">{expanded ? "▾" : "▸"}</span>
      {file.old_path !== undefined && <span className="old-path">{file.old_path}</span>}
      {file.old_path !== undefined && <span>→</span>}
      <span className="path">{file.path}</span>
      <span className="badges">
        <span>{STATUS_LABEL[file.status]}</span>
        {file.binary && <span>binary</span>}
        {commentCount > 0 && (
          <span className={unresolvedCount > 0 ? "badge badge-primary" : "badge badge-muted"}>
            {unresolvedCount > 0 ? `${unresolvedCount} open` : `${commentCount} resolved`}
          </span>
        )}
        <span className="stat-add">+{file.additions}</span>
        <span className="stat-del">−{file.deletions}</span>
      </span>
      <span className="fill" />
      <label
        className="viewed-box"
        onClick={(e) => e.stopPropagation()}
        title="Mark file as viewed (v)"
      >
        <button
          className={`sb-chk${viewed ? " on" : ""}`}
          aria-label={viewed ? "Mark not viewed" : "Mark viewed"}
          onClick={() => void toggleViewed(file.path)}
        />
        Viewed
      </label>
    </div>
  );
});
