/** Shared domain types for prediff. Schema follows ARCHITECTURE.md §4. */

// ---------------------------------------------------------------------------
// Diff ranges

/** Normalized diff range spec as given by the user, e.g. "working", "staged",
 * "HEAD", "v1..v2", or any commit-ish. */
export type RangeSpec = string;

// ---------------------------------------------------------------------------
// Diff manifest & hunks

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged";

export interface ManifestFile {
  /** New path (or old path for deletions). */
  path: string;
  /** Previous path for renames/copies. */
  old_path?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Content exceeds the large-diff threshold; hunks served only on demand. */
  large: boolean;
  old_mode?: string;
  new_mode?: string;
}

export interface DiffManifest {
  range: RangeSpec;
  generation: number;
  files: ManifestFile[];
  additions: number;
  deletions: number;
}

export type LineKind = "context" | "add" | "del";

export interface HunkLine {
  kind: LineKind;
  /** 1-based line number in the old file, null for added lines. */
  old_line: number | null;
  /** 1-based line number in the new file, null for deleted lines. */
  new_line: number | null;
  text: string;
  /** True when followed by "\ No newline at end of file". */
  no_newline?: boolean;
}

export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  /** Trailing section heading from the @@ line, if any. */
  header: string;
  lines: HunkLine[];
}

export interface FileDiff {
  path: string;
  old_path?: string;
  binary: boolean;
  /** True when hunks were withheld because the file diff is too large. */
  large: boolean;
  hunks: Hunk[];
}

// ---------------------------------------------------------------------------
// Session / review model

export type ReviewState = "reviewing" | "submitted";
export type CommentState = "open" | "resolved" | "outdated";
export type Side = "old" | "new";

export interface CommentReply {
  from: "agent" | "reviewer";
  text: string;
  created_at: string;
}

/** Context lines captured at comment creation, used for re-anchoring. */
export interface CommentAnchor {
  context_before: string[];
  /** The commented lines themselves (file content, not diff text). */
  lines: string[];
  context_after: string[];
}

export interface ReviewComment {
  id: string;
  file: string;
  line: number;
  end_line: number;
  side: Side;
  text: string;
  state: CommentState;
  /** Diff generation the comment was written against (or last re-anchored to). */
  generation: number;
  anchor: CommentAnchor;
  replies: CommentReply[];
  created_at: string;
  updated_at: string;
}

export interface Session {
  session_id: string;
  repo_root: string;
  range: RangeSpec;
  generation: number;
  review_state: ReviewState;
  created_at: string;
  updated_at: string;
  submitted_at?: string;
  comments: ReviewComment[];
}

// ---------------------------------------------------------------------------
// Daemon lockfile

export interface Lockfile {
  pid: number;
  port: number;
  url: string;
  repo_root: string;
  started_at: string;
}

// ---------------------------------------------------------------------------
// API payloads

export interface OpenResult {
  session_id: string;
  url: string;
  files: number;
  additions: number;
  deletions: number;
}

export interface StatusResult {
  session_id: string;
  range: RangeSpec;
  review_state: ReviewState;
  generation: number;
  url: string;
  comments: {
    total: number;
    open: number;
    resolved: number;
    outdated: number;
  };
}

export type WaitReason = "submitted" | "new-comments" | "timeout";

export interface WaitResult {
  reason: WaitReason;
  review_state: ReviewState;
  generation: number;
  /** Comments created since the baseline the caller passed. */
  new_comments: ReviewComment[];
}
