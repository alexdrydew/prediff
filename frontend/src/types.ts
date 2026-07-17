/**
 * Single source of truth for wire types: re-export the daemon's own domain
 * types (type-only, erased at build time — nothing from src/ is bundled).
 */
export type {
  CommentAnchor,
  CommentReply,
  CommentState,
  DiffManifest,
  FileDiff,
  FileStatus,
  Hunk,
  HunkLine,
  LineKind,
  ManifestFile,
  RangeSpec,
  ReviewComment,
  ReviewState,
  Session,
  Side,
} from "../../src/types";
