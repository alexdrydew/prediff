import type { ReactElement } from "react";
import { memo } from "react";
import type { ManifestFile } from "../../types";
import { toggleFile } from "../../state/store";

export const FileHeaderRow = memo(function FileHeaderRow({
  file,
  expanded,
  commentCount,
  openCommentCount,
}: {
  file: ManifestFile;
  expanded: boolean;
  commentCount: number;
  openCommentCount: number;
}): ReactElement {
  return (
    <div className="row-file" onClick={() => toggleFile(file.path)}>
      <span className="twisty">{expanded ? "▾" : "▸"}</span>
      {file.old_path !== undefined && <span className="old-path">{file.old_path}</span>}
      {file.old_path !== undefined && <span>→</span>}
      <span className="path">{file.path}</span>
      <span className="badges">
        <span>{file.status}</span>
        {file.binary && <span>binary</span>}
        {file.large && <span>large</span>}
        <span className="stat-add">+{file.additions}</span>
        <span className="stat-del">−{file.deletions}</span>
        {commentCount > 0 && (
          <span className="badge-comments">
            {openCommentCount > 0 ? `${openCommentCount} open / ` : ""}
            {commentCount} 💬
          </span>
        )}
      </span>
    </div>
  );
});
