# prediff frontend

Vite + React + TypeScript (strict) rendering core for the prediff review UI.

This is the **design-agnostic engine**: data layer, virtualization, and
functional-but-neutral UI. The visual design is being produced separately —
all colors/sizes live in `src/styles/tokens.css` (light + dark via
`prefers-color-scheme`, GitHub-like placeholders), components are small and
recomposable, and layout decisions are deliberately minimal.

## Commands

```sh
bun install        # once
bun run dev        # dev server; proxies /api + /events to a running daemon:
                   #   PREDIFF_URL=$(bun ../src/cli/index.ts status --json | jq -r .url) bun run dev
bun run build      # typecheck + build into ../public (served by the daemon as-is)
bun run test       # unit tests (bun test)
```

From the repo root: `bun run ui:install`, `bun run ui:build`, `bun run ui:dev`.
The daemon itself stays dependency-free; it just serves `public/`.

## Architecture

```
api/client.ts      typed fetch client for the daemon JSON API
api/sse.ts         reconnecting EventSource wrapper (backoff + resync hook)
state/store.ts     zustand vanilla store: server cache + client-only state
state/events.ts    SSE event → store mutation plan (pure, unit-tested)
state/selectors.ts memoized row-model derivation
lib/rows.ts        THE core: flattens everything into one Row[] for windowing
lib/pairing.ts     side-by-side del/add alignment
highlight/         worker + batching service + React hook
components/        one component per row kind + toolbar
```

### Rendering strategy

The entire review is **one flat virtualized list** (`@tanstack/react-virtual`)
over a derived row model: file headers → hunk headers → line rows (unified) or
pair rows (split) → inline comment threads → open composers. Only visible rows
exist in the DOM, so DOM size is bounded (~60 nodes) regardless of diff size.
Line rows are fixed-height (no wrapping; the canvas widens to the longest
loaded line, measured in `ch`), so the virtualizer does zero layout reads for
them; only threads/composers are measured.

Files start collapsed; expanding fetches `/api/diff/file?path=…` on demand.

### State & live updates

- zustand (vanilla store + tiny React binding) — chosen over context/reducer
  because per-row selector subscriptions avoid re-render cascades in a
  50k-row list, at ~1 kB of dependency.
- SSE events map to a pure `EventPlan` (`state/events.ts`):
  comment events upsert/remove in place; `generation` does a **soft refresh**
  (refetch manifest/session, reload hunks for expanded files) that preserves
  scroll position (the list never unmounts) and draft text (drafts live in a
  separate store slice keyed by file/side/line, never in localStorage);
  `session.changed` forces a full resync. Reconnects also resync.

### Syntax highlighting: highlight.js (not Shiki) — rationale

Requirements here: never block scrolling, lazy per-language, cheap startup,
worker-friendly. highlight.js wins for this use case:

- **Bundle/startup**: hljs core ≈ 8 kB + 2–14 kB per lazily-imported grammar
  chunk. Shiki needs the Oniguruma **WASM (~600 kB)** plus TextMate grammars
  (tens of kB each) and themes before the first token is colored.
- **Speed**: regex-engine line highlighting is comfortably faster than TM
  grammar scanning for the "highlight the viewport right now" pattern.
- **Tokens**: hljs emits classed spans, which map directly onto our CSS
  custom properties for theme-ability; Shiki inlines theme colors, fighting
  the token system.

Cost: hljs is less precise than TextMate grammars, and we highlight per line
(no multi-line constructs like block comments spanning lines) — acceptable
for diff hunks, and swappable later: the worker protocol
(`{id, lang, lines[]} → {id, html[]}`) hides the engine.

Flow: rows render **plain text immediately**; visible rows request
highlighting through a batching service (16 ms coalescing, per-language
batches, LRU-ish cache); the worker lazy-imports the grammar and returns
escaped HTML. Worker failure = plain text forever, never an error.

### Commenting

Click a gutter number (or drag a range) → composer opens inline →
`POST /api/comments` persists server-side immediately. Threads render inline
under their anchor line with open/resolved/outdated state and agent replies;
comments that can't be placed on a visible line (e.g. outdated after a
re-anchor miss) are appended detached at the end of their file — never
dropped. "Finish review" hits `/api/review/submit`.

## Server integration

`bun run build` outputs `index.html` + hashed `/assets/*` into `public/`.
The daemon serves `/` from `public/index.html` (unchanged) and got one small
addition: a `GET /assets/*` static route (see `src/server/server.ts`) since
Vite emits code-split chunks (worker, lazy grammars) that can't be inlined
into a single HTML file.

## Known gaps (deliberate, pending UX spec)

- Long lines in split mode are ellipsized (unified mode scrolls horizontally).
- Draft composers keep their file/side/line anchor across generation bumps;
  they are not fuzzily re-anchored client-side (server anchors on submit).
- No keyboard navigation, no file tree/sidebar — layout is the designer's call.
