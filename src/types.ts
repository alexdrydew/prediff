/**
 * Shared domain types for prediff. Schema follows ARCHITECTURE.md §4 and the
 * review model in design/prediff-interaction-spec.md (§0, §4.2, §5, §6.4).
 *
 * On-disk session schema version: 2 (see SCHEMA_VERSION). v1 sessions
 * (generation/review_state, open/outdated comment states) are migrated
 * leniently on load — see src/store/session.ts.
 */

export const SCHEMA_VERSION = 2;

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
  /** True for files not yet known to git (working range only): enumerated via
   * `ls-files --others` and diffed against /dev/null. */
  untracked?: boolean;
}

export interface DiffManifest {
  range: RangeSpec;
  /** The revision this manifest describes (numbered, spec §0.1). */
  revision: number;
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
// Session / review model (spec §0, §4.2, §5)

/**
 * Session-level state. `reviewing` is the working state; `ready` means the
 * developer clicked "Mark Ready" — satisfied, will push manually (spec §5.2).
 * Re-opening a ready session resets it to `reviewing`.
 */
export type SessionState = "reviewing" | "ready";

/**
 * Comment lifecycle (spec §4.2):
 *   draft     — written, autosaved server-side, NOT visible to the agent
 *   submitted — sent via "Send Feedback" (batch) or per-comment send-now
 *   addressed — a newer revision modified the anchored region
 *   resolved  — reviewer confirmed; terminal unless explicitly reopened
 *   orphaned  — anchor deleted / unmatchable in the current revision
 */
export type CommentState = "draft" | "submitted" | "addressed" | "resolved" | "orphaned";

/** Optional intent tag (spec §4.3). */
export type CommentTag = "must-fix" | "suggestion" | "question" | "nit";

/**
 * What a comment is anchored to (additive, QA gap §1.1):
 *   line      — a line range in a file (the classic case);
 *   file-note — a whole file, no line (line 0, empty anchor);
 *   review    — the review as a whole (file null, line 0, empty anchor) —
 *               GitHub's "review summary" equivalent.
 * Re-anchoring only ever touches `line` comments; the other kinds are never
 * addressed/orphaned automatically.
 */
export type CommentKind = "review" | "line" | "file-note";

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
  /** File the comment is anchored to; null for review-level comments. */
  file: string | null;
  /** 1-based; 0 for review-level comments and file notes. */
  line: number;
  end_line: number;
  side: Side;
  /** Anchoring kind (additive — older sessions are normalized on load:
   * file-note when line === 0 with a file, else line). */
  kind: CommentKind;
  text: string;
  state: CommentState;
  tag: CommentTag | null;
  /** Revision the comment was written against (or last re-anchored to). */
  revision: number;
  anchor: CommentAnchor;
  replies: CommentReply[];
  /** Feedback batch this comment was submitted in (null while draft). */
  batch_id: string | null;
  submitted_at?: string;
  created_at: string;
  updated_at: string;
}

/** One "Send Feedback" action (or a single-comment send-now). */
export interface FeedbackBatch {
  id: string;
  sent_at: string;
  comment_ids: string[];
}

export interface Session {
  schema_version: number;
  session_id: string;
  repo_root: string;
  range: RangeSpec;
  /** Current revision number; history retained on disk (spec §0.1). */
  revision: number;
  session_state: SessionState;
  /** Agent's stated task scope, from `prediff open --scope` (spec §9.4). */
  scope: string | null;
  /**
   * Explicit in-scope file patterns (globs), from `prediff open
   * --scope-files`. When present (non-null), the UI flags files matching no
   * pattern and skips the keyword heuristic entirely. Additive field —
   * absent/null on older sessions.
   */
  scope_files: string[] | null;
  /** Per-file "viewed" checkboxes; a file resets when its diff changes. */
  viewed_files: string[];
  comments: ReviewComment[];
  feedback_batches: FeedbackBatch[];
  created_at: string;
  updated_at: string;
  ready_at?: string;
}

// ---------------------------------------------------------------------------
// Revision history (raw diff + manifest snapshot per revision, spec §9.2)

export interface RevisionSnapshot {
  revision: number;
  created_at: string;
  manifest: DiffManifest;
  /** Full `git diff` output for this revision (stored gzipped on disk). */
  raw_diff: string;
}

/**
 * Per-revision new-side file contents (stored gzipped alongside the revision
 * snapshot, pruned with it) — the raw material for line-level interdiffs
 * between revisions (QA gap §1.4).
 */
export interface RevisionContents {
  revision: number;
  /** New-side lines per changed file; null = absent on the new side (deleted). */
  files: Record<string, string[] | null>;
  /** path → reason content was not materialized (binary / large file). */
  skipped: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Interdiff (what changed in a file BETWEEN two revisions, QA gap §1.4)

export interface InterdiffFileSummary {
  path: string;
  additions: number;
  deletions: number;
  /** False when hunks can't be served (content not materialized at one of
   * the revisions — binary / large file / pre-interdiff snapshot). */
  available: boolean;
  /** Why the interdiff is unavailable (set when available is false). */
  reason?: string;
}

/** GET /api/interdiff/manifest?from&to */
export interface InterdiffManifest {
  from: number;
  to: number;
  /** Only files whose new-side content differs between the two revisions. */
  files: InterdiffFileSummary[];
  additions: number;
  deletions: number;
}

/** GET /api/interdiff?file&from&to — same hunk shape as /api/diff/file. */
export interface InterdiffFile extends FileDiff {
  from: number;
  to: number;
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
  revision: number;
  session_state: SessionState;
}

export interface CommentCounts {
  total: number;
  draft: number;
  submitted: number;
  addressed: number;
  resolved: number;
  orphaned: number;
  /** Per-kind breakdown (additive). */
  kinds: Record<CommentKind, number>;
}

export interface StatusResult {
  session_id: string;
  range: RangeSpec;
  session_state: SessionState;
  revision: number;
  url: string;
  scope: string | null;
  scope_files: string[] | null;
  comments: CommentCounts;
  /** Number of files currently marked viewed. */
  viewed_files: number;
}

export interface MarkReadyResult {
  ok: boolean;
  session_state: SessionState;
  ready_at: string;
  comments: CommentCounts;
}

export interface SendFeedbackResult {
  batch: FeedbackBatch;
  comments: ReviewComment[];
}

/** Summary of one stored revision (for the session-history list, spec §9.2). */
export interface RevisionInfo {
  revision: number;
  created_at: string;
  files: number;
  additions: number;
  deletions: number;
}

export interface RevisionsResult {
  current: number;
  /** Revision numbers still on disk (bounded history, oldest pruned). */
  available: number[];
  /** Per-revision summaries, ascending by revision number. */
  revisions: RevisionInfo[];
}

/** GET /api/file — one side's full content, for "Expand context" (spec §3.2). */
export interface FileContentResult {
  path: string;
  side: Side;
  lines: string[];
}

export type WaitReason = "ready" | "feedback" | "timeout";

export interface WaitResult {
  reason: WaitReason;
  session_state: SessionState;
  revision: number;
  /** Batch that woke the wait (null on ready/timeout). */
  batch_id: string | null;
  /** The batch's comments (empty on ready/timeout). */
  comments: ReviewComment[];
}
