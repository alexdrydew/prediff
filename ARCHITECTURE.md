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
- Watches the repo (debounced `git status --porcelain` + head hash) to
  auto-refresh the diff when the range is `working`/`staged`.

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
  "review_state": "reviewing",  // reviewing | submitted
  "comments": [{
    "id": "…", "file": "src/x.ts", "line": 42, "end_line": 45,
    "side": "new", "text": "…",
    "state": "open",            // open | resolved
    "generation": 2,            // diff generation it was written against
    "anchor": { "context_before": [...], "context_after": [...] },
    "replies": [{ "from": "agent", "text": "Fixed in …" }]
  }]
}
```

**Comment anchoring across generations:** when the diff refreshes, comments
re-anchor by matching their stored context lines (like git apply's fuzzy
matching). Comments that no longer match are shown in an "outdated" section,
never dropped.

**Review lifecycle:** comments are live to the agent the instant they're
written (no batching requirement), but the UI offers an explicit
**"Send to agent / Finish review"** action that flips `review_state` to
`submitted` — that's what `prediff wait` primarily watches. Exact semantics to
be refined by the UX design spec.

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

## Open questions (for architecture review)

1. Session-per-range vs one session per repo with range switching?
2. Comment re-anchoring algorithm: context-line fuzzy match enough, or track
   through `git diff` between generations?
3. SSE vs WebSocket (SSE chosen for simplicity; any reason to upgrade?).
4. Should `wait` also stream events (NDJSON) for richer agent loops?
5. Distribution: npm package with Bun bundled-compile per platform, or
   require bun/node at runtime?
