# prediff — Architecture (draft v1)

A fast, local, **agent-first** diff review tool. A coding agent makes changes,
starts prediff, and the developer reviews the diff in the browser — leaving
line comments the agent then acts on — before anything reaches GitHub.

Successor-in-spirit to [difit](https://github.com/yoshiko-pg/difit), designed
around its two failure modes:

1. **Feedback loss / agent timeouts.** In difit, comments live in browser
   localStorage and the agent blocks waiting for the review to finish. If the
   agent times out or the process dies, feedback is stranded.
2. **Slow on large diffs.** The whole diff is rendered and highlighted up
   front; multi-thousand-line diffs crawl.

## Design principles

- **Durable by default.** Every comment is persisted to disk server-side the
  moment it's created. Nothing depends on a browser tab or an agent turn
  staying alive.
- **Non-blocking agent protocol.** Every agent-facing CLI command returns
  immediately (or with an explicit, bounded, *safe-to-retry* wait). A timeout
  never loses state — the agent just asks again.
- **Lazy everything.** The frontend receives a file manifest first; hunk
  content, syntax highlighting, and rendering are all on-demand and
  virtualized.
- **The review is a session, not a request.** The agent can push a revised
  diff mid-review; the reviewer's draft comments and scroll context survive.

## Components

```
┌────────────┐   spawn/CLI (JSON)   ┌─────────────────┐   HTTP + SSE   ┌──────────┐
│ Coding      │ ───────────────────▶│ prediff server   │◀──────────────▶│ Browser  │
│ agent       │◀─────────────────── │ (per-repo daemon)│                │ review UI│
└────────────┘    exit-immediately  └────────┬────────┘                └──────────┘
                                             │ atomic JSON writes
                                             ▼
                                   ~/.local/share/prediff/<repo-id>/
                                     sessions/<session-id>.json
```

### 1. CLI (`prediff`)

Single Bun-compiled binary (also runnable via `bunx prediff`). Two audiences:

**Human:** `prediff` / `prediff <commit-ish>` — like difit: start server if
needed, open browser.

**Agent (all support `--json`, all exit immediately unless noted):**

| Command | Behavior |
|---|---|
| `prediff open [range] --json` | Ensure daemon running, create (or refresh) a review session for the given diff range (`HEAD`, `working`, `staged`, `A..B`). Prints `{session_id, url, files, additions, deletions}`. |
| `prediff status --json` | Session snapshot: review state (`reviewing` / `submitted`), comment counts, diff generation number. |
| `prediff comments --json [--unresolved]` | All comments with file/line/side/text/state. |
| `prediff wait --timeout <s> --json` | Bounded long-poll: returns on review submit, new comment, or timeout — whichever first. Timeout is **safe**: state is on disk, call again. Exit code distinguishes `submitted` / `new-comments` / `timeout`. |
| `prediff resolve <comment-id> [--reply <text>] --json` | Mark a comment addressed (with optional agent reply, shown in UI). |
| `prediff refresh --json` | Recompute the diff (after the agent edited files); bumps generation, notifies UI via SSE. (Server also auto-watches the repo; this is the explicit hook.) |
| `prediff stop` | Stop daemon for this repo. |

### 2. Server (per-repo daemon)

- `Bun.serve` on a per-repo port (written to a lockfile under the state dir;
  `open` reuses a live daemon, replaces a dead lockfile).
- Serves the static UI, a JSON API, and an **SSE** stream (`/events`) for
  live updates (new diff generation, comment resolved by agent, agent replies).
- Outlives the agent process (detached spawn). `--ttl` option to self-stop
  after N minutes idle (no UI or CLI activity), default a few hours.
- Watches the repo (debounced `git status --porcelain` + head hash, plus
  mtime+size of dirty paths — porcelain output alone doesn't change when an
  already-dirty file is edited again) to auto-refresh the diff when the range
  is `working`/`staged`.

### 3. Diff engine

- Shells out to `git` directly (`git diff --no-color --unified=3 -z`,
  `git show`, `git diff --numstat`) — no simple-git dependency; parse the
  unified diff into structured hunks.
- Two-phase API:
  - `GET /api/diff` → manifest only: files, per-file add/del counts, rename
    status, generation number. Fast even for huge diffs.
  - `GET /api/diff/file?path=…` → hunks for one file, on demand.
- Binary/huge-file guards (skip content over a size threshold, offer raw).

### 4. Persistence & the review model

State dir: `~/.local/share/prediff/<repo-id>/` where `repo-id` is a hash of
the repo's absolute path. Session file (atomic write-temp-then-rename on every
mutation):

```jsonc
{
  "session_id": "…",
  "range": "working",
  "generation": 3,              // bumped each diff refresh
  "session_state": "reviewing", // reviewing | ready   (ready = "Mark Ready")
  "revision": 3,                // current revision number; history retained
  "comments": [{
    "id": "…", "file": "src/x.ts", "line": 42, "end_line": 45,
    "side": "new", "text": "…", "tag": "must-fix",  // must-fix|suggestion|question|nit|null
    "state": "submitted",       // draft | submitted | addressed | resolved | orphaned
    "revision": 2,              // revision it was written against
    "anchor": { "context_before": [...], "context_after": [...] },
    "replies": [{ "from": "agent", "text": "Fixed in …" }]
  }],
  "viewed_files": ["src/x.ts"]  // per-file "viewed" checkboxes, persisted
}
```

The review model follows the design spec (`design/prediff-interaction-spec.md`
— authoritative for all UX semantics):

- **Revisions, not silent refreshes.** Each diff recompute is a numbered
  revision; raw diff text per revision is persisted (compressed) so older
  revisions stay viewable. The UI never auto-applies a new revision — it
  queues behind a banner; the reviewer switches when ready.
- **Comment lifecycle** (spec §4.2): `draft` (autosaved server-side, not yet
  visible to the agent) → `submitted` (via **Send Feedback**, which batches
  all drafts and wakes the agent; per-comment "send now" also exists) →
  `addressed` (automatic when a new revision *modifies* the anchored region)
  → `resolved` (reviewer confirms). Re-anchoring outcomes per revision:
  unchanged/shifted → follows silently; modified → `addressed`;
  deleted/unmatchable → `orphaned` (surfaced for triage, never dropped).
- **Session actions** (spec §5): **Send Feedback** (the loop-closing action,
  many times per session) and **Mark Ready** (session complete; developer
  pushes manually outside the tool). No GitHub-style "submit review".
- `prediff wait` returns on: feedback batch (exit 2), Mark Ready (exit 0),
  or timeout (exit 3). `prediff open --scope "<stated task>"` passes the
  agent's stated scope so the UI can flag files outside it (spec §9.4).

### 5. Frontend

- Vite + React + TypeScript (familiar ecosystem; perf comes from
  architecture, not framework).
- **Virtualized rendering** (@tanstack/react-virtual): only visible lines are
  in the DOM. Files render as collapsed headers first; content loads on
  expand/scroll.
- **Syntax highlighting off the main thread**, viewport-only, in a Web Worker
  (Shiki lazy-loaded per-language, or highlight.js if bundle size wins).
- SSE-driven live updates: new generation → soft refresh preserving scroll
  position and draft comments (re-anchored).
- No comment state in localStorage — the server is the source of truth;
  drafts are debounce-synced.

### 6. Agent skill

`skills/prediff-review/SKILL.md`, installable to `~/.claude/skills/`. Teaches
the loop:

1. `prediff open working --json` → surface URL to the developer.
2. `prediff wait --timeout 240 --json` in a loop (timeouts are normal, not
   errors — re-invoke; state is never lost).
3. On comments: fix code → `prediff refresh` → `prediff resolve <id> --reply …`.
4. Repeat until review submitted with zero unresolved comments.

## Performance targets (vs difit, measured)

| Metric | Target |
|---|---|
| `open` → URL printed | < 300 ms warm daemon, < 1.5 s cold |
| 10k-line diff: first contentful render | < 1 s |
| 50k-line diff: scroll at 60 fps, memory < 500 MB tab | yes |
| Agent CLI round-trip (`status`, `comments`) | < 100 ms |

Benchmark harness: `bench/` generates synthetic repos with parameterized diff
sizes; runs both prediff and difit headless, measures server response times
and (via Playwright) render timings.

## Decisions made during phase-1 implementation

- **One current session per repo** (open question 1): `open` with a different
  range replaces the current session; old session files stay on disk but
  aren't API-addressable. Revisit if multi-range review turns out to matter.
- **Re-`open` of a ready session resets it to `reviewing`** (a new review
  round), consistent with the spec's sessions-are-resumable model (§9.1).
- Phase-1 comment states `open`/`outdated` were superseded by the design
  spec's five-state lifecycle (see above); `open` maps to `submitted`,
  `outdated` to `orphaned`.

## Open questions (for architecture review)

1. Comment re-anchoring algorithm: context-line fuzzy match enough, or track
   through `git diff` between generations? Known gap: anchors are
   file-content-based, so `old`-side comments on `working` ranges re-anchor
   against HEAD and can shift silently if the user commits mid-review.
2. SSE vs WebSocket (SSE chosen for simplicity; any reason to upgrade?).
3. `wait` semantics: server snapshots known comments at request start, so a
   comment landing between two `wait` calls is attributed to the previous
   response. A client-supplied cursor (last-seen comment seq) would be
   cleaner — possibly alongside an NDJSON streaming mode for richer agent
   loops.
4. Distribution: npm package with Bun bundled-compile per platform, or
   require bun/node at runtime?
