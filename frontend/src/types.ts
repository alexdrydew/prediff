/**
 * Single source of truth for wire types: re-export the daemon's own domain
 * types (type-only, erased at build time — nothing from src/ is bundled).
 */
export type {
  CommentAnchor,
  CommentCounts,
  CommentReply,
  CommentState,
  CommentTag,
  DiffManifest,
  FeedbackBatch,
  FileDiff,
  FileStatus,
  Hunk,
  HunkLine,
  LineKind,
  ManifestFile,
  MarkReadyResult,
  RangeSpec,
  ReviewComment,
  RevisionsResult,
  SendFeedbackResult,
  Session,
  SessionState,
  Side,
} from "../../src/types";
