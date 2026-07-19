# prediff

> [!NOTE]
> **This project is an experiment: 100% of it was built by an LLM (Claude)
> paired with [tendem.ai](https://tendem.ai).** All code, architecture, tests,
> and benchmarks were written by the LLM; the UX/interaction design spec,
> visual design, and design tokens were produced by a human expert designer
> commissioned through Tendem. No line of code was written by a human.

A fast, local, agent-first diff review tool. A coding agent makes changes,
starts prediff, and the developer reviews the diff in the browser — leaving
comments the agent then acts on — before anything reaches GitHub.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design,
[design/](./design/) for the commissioned design package, and
[skills/prediff-review/](./skills/prediff-review/SKILL.md) for the agent skill.

## Why

Inspired by [difit](https://github.com/yoshiko-pg/difit), redesigned around
its two failure modes for the agent-review loop:

- **Feedback is never lost.** Comments persist to disk server-side the moment
  they exist; the daemon outlives the agent; `wait` timeouts are safe and
  ordinary. No localStorage, no "submit or lose it".
- **Flat performance on huge diffs.** Manifest-first loading + virtualized
  rendering + worker-based highlighting: first diff line in ~160 ms whether
  the diff is 1k or 50k lines (difit: ~10× slower and >10× the memory at 50k
  — see [bench/RESULTS.md](./bench/RESULTS.md)).

## Install

Every path except Nix requires the [Bun](https://bun.sh) runtime — the CLI
and daemon run on Bun, not Node.

### Nix (flakes) — real `prediff` binary, no Bun needed

```sh
# run directly, no install
nix run github:alexdrydew/prediff -- open working

# or install into your profile
nix profile install github:alexdrydew/prediff
prediff open working
```

Or add `github:alexdrydew/prediff` as a flake input and use
`packages.<system>.default`. A dev shell with bun is available via
`nix develop`.

### Bun — global `prediff` command

```sh
bun install -g github:alexdrydew/prediff
prediff open working
```

Or from a clone (useful for development):

```sh
git clone https://github.com/alexdrydew/prediff && cd prediff
bun link          # puts a global `prediff` in ~/.bun/bin
prediff open working
```

Both put `prediff` in `~/.bun/bin` — make sure that's on your PATH. The
package is not yet published to the npm registry; once it is,
`bun install -g prediff` and `bunx prediff` will work too (Bun runtime still
required — the package ships TypeScript sources that Bun runs directly).

### Plain clone (no install)

```sh
git clone https://github.com/alexdrydew/prediff && cd prediff
bun install
bun src/cli/index.ts open working
```

> [!IMPORTANT]
> The agent skill ([skills/prediff-review/SKILL.md](./skills/prediff-review/SKILL.md))
> invokes `prediff <cmd>` and assumes it's on PATH. If you only run from a
> plain clone, agents following the skill will fail on the first command —
> use one of the install paths above (or `bun link`) before handing the
> skill to an agent.

## Usage

```sh
# human: review the working tree diff in the browser
prediff open working

# agent loop
prediff open working --scope "<the task>" --json
prediff wait --timeout 240 --json
prediff comments --json --unresolved
prediff suggestion <comment-id> --json     # reviewer's exact replacement text
prediff resolve <comment-id> --reply "fixed" --json
prediff refresh --json
prediff stop
```

Ranges: `working` (default; staged+unstaged vs HEAD), `staged`, `HEAD`
(last commit), any commit-ish, or `A..B` / `A...B`.

Notes for the loop:

- **The port is per-repo** (and stable across daemon restarts). Never assume
  a port number — always read the `url` field from the `--json` output.
- **Headless / SSH boxes:** in human mode `open` launches a browser; pass
  `--no-browser` or set `PREDIFF_NO_BROWSER=1` to skip that and just print
  the URL. (`--json` mode never opens a browser.)
- **Large files are handled on purpose:** files with more than 800 changed
  lines start auto-collapsed, and above 5000 changed lines the diff content
  is withheld until you click "Load anyway" in the UI. That's a speed
  guard, not a failure.

## Features

The full agent-review loop, plus the review surface around it:

- **Persisted five-state comments** (draft → submitted → addressed →
  resolved / orphaned) with revisioned sessions, Send Feedback / Mark Ready,
  orphan triage, and threaded agent replies.
- **Review-level comments** — change-wide feedback with no line anchor
  (GitHub's "review summary" equivalent). These reach the agent through the
  same `comments`/`wait` channel as line comments, with `file: null`.
- **Applyable suggestions** — a reviewer can attach exact replacement text
  to a line comment; the agent fetches it with `prediff suggestion <id>
  --json` (which includes the current file lines, so it can verify before
  applying).
- **In-diff content search** — press Cmd/Ctrl+F in the UI. Search runs
  server-side over every hunk, so matches in collapsed and withheld files
  are found too.
- **Interdiff between revisions** — after the agent refreshes, view exactly
  what changed since a previous revision (line-level rev-N vs rev-M diff),
  not just the whole diff again.
- **Directory-tree file list** with tree-ordered keyboard navigation
  (`n`/`p` files, `j`/`k` hunks, `c` to comment).
- **Out-of-scope flagging** — pass `--scope "<task>"` on `open` and files
  unrelated to the stated task get an informational ⚠ flag (content-aware:
  matches scope words against changed-line content, not just paths). Pass
  `--scope-files "src/lib/**,src/routes/x.ts"` to declare the in-scope set
  explicitly instead. Flags never block anything.
- Side-by-side & unified views, viewed-file tracking, light/dark,
  session history with every revision viewable.

## Development

```sh
bun test
bun bench/bench.ts --lines 10000
```

The web UI in `public/` ships prebuilt and committed — there is no frontend
build step to use prediff. `bun run ui:build` (and `frontend/`) are only
needed when developing the UI itself.

State lives under `~/.local/share/prediff/<repo-id>/` (override with
`PREDIFF_STATE_DIR`).

## License

[MIT](./LICENSE)
