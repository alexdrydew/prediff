import {
  CodeView,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import type {
  CodeViewItem,
  CodeViewOptions,
  DiffLineAnnotation,
  LineAnnotation,
  OnDiffLineClickProps,
  OnLineClickProps,
  SelectedLineRange,
} from "@pierre/diffs";
import { useEffect, useMemo, useRef, type ReactElement } from "react";
import type { ManifestFile, ReviewComment, Side } from "../types";
import { lineInDiff, pierreFileDiff } from "../lib/diffs";
import { selectExpanded, selectOrderedFiles } from "../state/selectors";
import {
  loadFileDiff,
  openComposer,
  reanchorTo,
  setActiveContext,
  shownRevision,
  store,
  toggleFile,
  toggleViewed,
  useStore,
  type ComposerTarget,
  type FileDiffState,
} from "../state/store";
import {
  noteActiveLine,
  registerDiffController,
  type DiffLocation,
} from "../state/controller";
import { ViewedCheckbox } from "./ViewedCheckbox";
import { ThreadRow } from "./rows/ThreadRow";
import { ComposerRow } from "./rows/ComposerRow";
import { ReviewComposerRow } from "./rows/ReviewComposerRow";
import { MetaRow, type MetaVariant } from "./rows/MetaRow";

const REVIEW_ID = "\0review";

type Annotation =
  | { kind: "comment"; comment: ReviewComment; detached: boolean }
  | { kind: "composer"; target: ComposerTarget }
  | { kind: "review-composer" }
  | { kind: "meta"; path: string; variant: MetaVariant; message?: string; lines?: number };

type ItemContext = { item: CodeViewItem<Annotation> };
type AnyLineClick = OnDiffLineClickProps | OnLineClickProps;

interface ViewerFile {
  file: ManifestFile;
  state: FileDiffState | undefined;
  expanded: boolean;
  unavailable?: string;
}

const versions = new Map<string, { signature: string; value: number }>();

function itemVersion(id: string, signature: string): number {
  const current = versions.get(id);
  if (current?.signature === signature) return current.value;
  const value = (current?.value ?? 0) + 1;
  versions.set(id, { signature, value });
  return value;
}

export function DiffViewer(): ReactElement {
  const ref = useRef<CodeViewHandle<Annotation>>(null);
  const orderedFiles = useStore(selectOrderedFiles);
  const normalExpanded = useStore(selectExpanded);
  const fileDiffs = useStore((state) => state.fileDiffs);
  const comments = useStore((state) => state.comments);
  const composers = useStore((state) => state.composers);
  const reviewComposerOpen = useStore((state) => state.reviewComposerOpen);
  const interdiff = useStore((state) => state.interdiff);
  const viewMode = useStore((state) => state.viewMode);
  const wrapLines = useStore((state) => state.wrapLines);
  const theme = useStore((state) => state.theme);
  const session = useStore((state) => state.session);
  const viewingRevision = useStore((state) => shownRevision(state));
  const searchHighlight = useStore((state) => state.searchHighlight);

  const files = useMemo<ViewerFile[]>(() => {
    if (interdiff?.manifest) {
      return interdiff.manifest.files.map((summary) => {
        const state = interdiff.diffs[summary.path];
        return {
          file: {
            path: summary.path,
            status: "modified",
            additions: summary.additions,
            deletions: summary.deletions,
            binary: false,
            large: false,
          },
          state:
            state?.status === "ready" && state.diff
              ? { status: "ready", diff: state.diff, revision: 0 }
              : state?.status === "error"
                ? { status: "error", revision: 0, error: state.error }
                : state?.status === "loading"
                  ? { status: "loading", revision: 0 }
                  : undefined,
          expanded: !interdiff.collapsed.has(summary.path),
          ...(!summary.available
            ? { unavailable: summary.reason ?? "content not recorded" }
            : {}),
        };
      });
    }
    return orderedFiles.map((file) => ({
      file,
      state: fileDiffs[file.path],
      expanded: normalExpanded.has(file.path),
    }));
  }, [fileDiffs, interdiff, normalExpanded, orderedFiles]);

  const items = useMemo<CodeViewItem<Annotation>[]>(() => {
    const result: CodeViewItem<Annotation>[] = [];
    const reviewComments = comments.filter((comment) => comment.file === null);
    if (reviewComments.length > 0 || reviewComposerOpen) {
      const annotations: LineAnnotation<Annotation>[] = reviewComments.map((comment) => ({
        lineNumber: 0,
        metadata: { kind: "comment", comment, detached: false },
      }));
      if (reviewComposerOpen) {
        annotations.push({ lineNumber: 0, metadata: { kind: "review-composer" } });
      }
      result.push({
        id: REVIEW_ID,
        type: "file",
        file: { name: "Review comments", contents: "" },
        annotations,
        version: itemVersion(
          REVIEW_ID,
          `${reviewComments.map(commentSignature).join("|")}:${reviewComposerOpen}`,
        ),
      });
    }

    for (const entry of files) {
      const { file, state } = entry;
      const fileComments = comments.filter((comment) => comment.file === file.path);
      const fileComposers = Object.values(composers).filter(
        (composer) => composer.file === file.path,
      );
      const annotations: DiffLineAnnotation<Annotation>[] = [];
      const complete =
        typeof state?.oldContent === "string" && typeof state.newContent === "string";
      for (const comment of fileComments) {
        const visible =
          comment.line > 0 &&
          comment.state !== "orphaned" &&
          (complete || lineInDiff(state?.diff, comment.side, comment.line));
        annotations.push({
          side: visible ? pierreSide(comment.side) : fileAnnotationSide(file),
          lineNumber: visible ? comment.line : 0,
          metadata: { kind: "comment", comment, detached: !visible && comment.line > 0 },
        });
      }
      for (const target of fileComposers) {
        annotations.push({
          side: pierreSide(target.side),
          lineNumber: target.line,
          metadata: { kind: "composer", target },
        });
      }
      const meta = metaAnnotation(entry);
      if (meta) {
        annotations.push({ side: fileAnnotationSide(file), lineNumber: 0, metadata: meta });
      }

      const signature = [
        state?.status ?? "idle",
        state?.revision ?? 0,
        entry.expanded,
        state?.diff?.hunks.length ?? -1,
        fileComments.map(commentSignature).join("|"),
        fileComposers.map((composer) => composer.key).join("|"),
        entry.unavailable ?? "",
      ].join(":");
      result.push({
        id: file.path,
        type: "diff",
        fileDiff: pierreFileDiff(
          file,
          state,
          `${session?.session_id ?? "session"}:${viewingRevision ?? 0}:${file.path}`,
        ),
        annotations,
        collapsed: !entry.expanded,
        version: itemVersion(file.path, signature),
      });
    }
    return result;
  }, [
    comments,
    composers,
    files,
    reviewComposerOpen,
    session?.session_id,
    viewingRevision,
  ]);

  const fileMap = useMemo(
    () => new Map(files.map((entry) => [entry.file.path, entry])),
    [files],
  );

  const options = useMemo<CodeViewOptions<Annotation>>(
    () => ({
      themeType: theme,
      diffStyle: viewMode,
      overflow: wrapLines ? "wrap" : "scroll",
      diffIndicators: "classic",
      lineDiffType: "word-alt",
      // Diffs' native line-info separator makes the collapsed line count and
      // direction control clickable, matching GitHub's context expansion.
      hunkSeparators: "line-info",
      // Keep unchanged regions collapsed initially and reveal 20 lines per
      // interaction without materializing an entire large file.
      expandUnchanged: false,
      expansionLineCount: 20,
      stickyHeaders: true,
      pointerEventsOnScroll: true,
      // CodeView reuses the placeholder header while an item lazily loads.
      // Prediff renders stable manifest counts in the metadata slot instead.
      unsafeCSS: "[data-additions-count],[data-deletions-count]{display:none}",
      // Keep native browser text selection independent from review gestures.
      // Diffs' gutter utility owns line/range comments, while dragging over
      // code remains a normal text selection.
      enableGutterUtility: interdiff === null,
      lineHoverHighlight: "both",
      onLineClick: (line: AnyLineClick, context: ItemContext) => {
        if (context.item.type !== "diff" || !("annotationSide" in line)) return;
        const location: DiffLocation = {
          file: context.item.id,
          side: prediffSide(line.annotationSide),
          line: line.lineNumber,
        };
        noteActiveLine(location);
        if (store.getState().reanchoring !== null) {
          void reanchorTo(location.side, location.line);
        }
      },
      onGutterUtilityClick: (range: SelectedLineRange, context: ItemContext) => {
        if (context.item.type !== "diff") return;
        const side = prediffSide(range.endSide ?? range.side ?? "additions");
        openComposer(
          context.item.id,
          side,
          Math.min(range.start, range.end),
          Math.max(range.start, range.end),
        );
      },
    }),
    [interdiff, theme, viewMode, wrapLines],
  );

  useEffect(() => {
    registerDiffController({
      scrollToItem: (path, align = "start") =>
        ref.current?.scrollTo({ type: "item", id: path, align }),
      scrollToLine: (location, align = "center") =>
        ref.current?.scrollTo({
          type: "line",
          id: location.file,
          lineNumber: location.line,
          side: pierreSide(location.side),
          align,
        }),
      scrollToTop: () =>
        ref.current?.scrollTo({ type: "position", position: 0 }),
      clearSelection: () => ref.current?.clearSelectedLines(),
    });
    return () => registerDiffController(null);
  }, []);

  useEffect(() => {
    if (searchHighlight) {
      ref.current?.setSelectedLines({
        id: searchHighlight.file,
        range: {
          start: searchHighlight.line,
          end: searchHighlight.line,
          side: pierreSide(searchHighlight.side),
        },
      });
    } else {
      ref.current?.clearSelectedLines();
    }
  }, [searchHighlight]);

  return (
    <div className="diff-wrap pierre-diff-wrap">
      <CodeView<Annotation>
        ref={ref}
        items={items}
        options={options}
        className="pierre-code-view"
        onScroll={(scrollTop, viewer) => {
          const rendered = viewer.getRenderedItems().filter((item) => item.id !== REVIEW_ID);
          let active = rendered[0]?.id ?? null;
          for (const item of rendered) {
            const top = viewer.getTopForItem(item.id);
            if (top !== undefined && top <= scrollTop + 8) active = item.id;
          }
          setActiveContext(active);
        }}
        renderHeaderPrefix={(item) => {
          if (item.id === REVIEW_ID) return null;
          const entry = fileMap.get(item.id);
          return entry ? <HeaderPrefix entry={entry} /> : null;
        }}
        renderHeaderMetadata={(item) => {
          if (item.id === REVIEW_ID) return null;
          const entry = fileMap.get(item.id);
          return entry ? <HeaderMetadata entry={entry} /> : null;
        }}
        renderAnnotation={(annotation) =>
          annotation.metadata ? <AnnotationView annotation={annotation.metadata} /> : null
        }
      />
    </div>
  );
}

function HeaderPrefix({ entry }: { entry: ViewerFile }): ReactElement {
  useEffect(() => {
    if (
      entry.expanded &&
      entry.unavailable === undefined &&
      !entry.file.binary &&
      entry.state === undefined
    ) {
      void loadFileDiff(entry.file.path);
    }
  }, [entry]);
  return (
    <button
      className="diffs-toggle"
      title={entry.expanded ? "Collapse file" : "Expand file"}
      onClick={(event) => {
        event.stopPropagation();
        toggleFile(entry.file.path);
      }}
    >
      {entry.expanded ? "▾" : "▸"}
    </button>
  );
}

function HeaderMetadata({ entry }: { entry: ViewerFile }): ReactElement {
  const commentCount = useStore(
    (state) => state.comments.filter((comment) => comment.file === entry.file.path).length,
  );
  const unresolved = useStore(
    (state) =>
      state.comments.filter(
        (comment) => comment.file === entry.file.path && comment.state !== "resolved",
      ).length,
  );
  const viewed = useStore((state) => state.viewedFiles.has(entry.file.path));
  const interdiff = useStore((state) => state.interdiff !== null);
  return (
    <span className="diffs-header-meta">
      {entry.state?.status === "loading" && <span className="badge badge-muted">loading…</span>}
      {entry.file.deletions > 0 && (
        <span className="diffs-stat deletions">−{entry.file.deletions}</span>
      )}
      {entry.file.additions > 0 && (
        <span className="diffs-stat additions">+{entry.file.additions}</span>
      )}
      {commentCount > 0 && (
        <span className={unresolved ? "badge badge-primary" : "badge badge-muted"}>
          {unresolved || commentCount} {unresolved ? "open" : "resolved"}
        </span>
      )}
      {!interdiff && (
        <ViewedCheckbox
          viewed={viewed}
          onClick={(event) => {
            event.stopPropagation();
            void toggleViewed(entry.file.path);
          }}
        />
      )}
    </span>
  );
}

function AnnotationView({ annotation }: { annotation: Annotation }): ReactElement {
  switch (annotation.kind) {
    case "comment":
      return <ThreadRow comment={annotation.comment} detached={annotation.detached} />;
    case "composer":
      return <ComposerRow target={annotation.target} />;
    case "review-composer":
      return <ReviewComposerRow />;
    case "meta":
      return (
        <MetaRow
          path={annotation.path}
          variant={annotation.variant}
          message={annotation.message}
          lines={annotation.lines}
        />
      );
  }
}

function metaAnnotation(
  entry: ViewerFile,
): Extract<Annotation, { kind: "meta" }> | null {
  const { file, state, unavailable } = entry;
  if (unavailable !== undefined) {
    return { kind: "meta", path: file.path, variant: "unavailable", message: unavailable };
  }
  if (file.binary) return { kind: "meta", path: file.path, variant: "binary" };
  if (state?.status === "error") {
    return { kind: "meta", path: file.path, variant: "error", message: state.error };
  }
  if (state?.diff?.large && state.diff.hunks.length === 0) {
    return {
      kind: "meta",
      path: file.path,
      variant: "large",
      lines: file.additions + file.deletions,
    };
  }
  if (state?.status === "ready" && state.diff?.hunks.length === 0) {
    return { kind: "meta", path: file.path, variant: "empty" };
  }
  return null;
}

function commentSignature(comment: ReviewComment): string {
  return [
    comment.id,
    comment.state,
    comment.revision,
    comment.line,
    comment.end_line,
    comment.text,
    comment.tag ?? "",
    comment.suggestion ?? "",
    comment.replies.length,
  ].join(":");
}

function pierreSide(side: Side): "deletions" | "additions" {
  return side === "old" ? "deletions" : "additions";
}

function prediffSide(side: "deletions" | "additions"): Side {
  return side === "deletions" ? "old" : "new";
}

function fileAnnotationSide(file: ManifestFile): "deletions" | "additions" {
  return file.status === "deleted" ? "deletions" : "additions";
}
