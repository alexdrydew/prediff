# prediff

> [!NOTE]
> **This project is an experiment: 100% of it was built by an LLM (Claude)
> paired with [tendem.ai](https://tendem.ai).** All code, architecture, tests,
> and benchmarks were written by the LLM; the UX/interaction design spec,
> visual design, and design tokens were produced by a human expert designer
> commissioned through Tendem. No line of code was written by a human.

A fast, local, agent-first diff review tool. A coding agent makes changes,
starts prediff, and the developer reviews the diff in the browser — leaving
line comments the agent then acts on — before anything reaches GitHub.

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

## Status

Feature-complete for the core loop: revisioned sessions, five-state comment
lifecycle (draft → submitted → addressed → resolved / orphaned), Send
Feedback / Mark Ready, orphan triage, viewed-file tracking, scope flagging,
side-by-side & unified views, keyboard-first navigation, light/dark. Not yet
packaged for distribution (runs from source via Bun).

## Usage

```sh
bun install

# human: review the working tree diff in the browser
bun src/cli/index.ts open working

# agent loop
bun src/cli/index.ts open working --json
bun src/cli/index.ts wait --timeout 240 --json
bun src/cli/index.ts comments --json --unresolved
bun src/cli/index.ts resolve <comment-id> --reply "fixed" --json
bun src/cli/index.ts refresh --json
bun src/cli/index.ts stop
```

Ranges: `working` (default; staged+unstaged vs HEAD), `staged`, `HEAD`
(last commit), any commit-ish, or `A..B` / `A...B`.

## Development

```sh
bun test
bun bench/bench.ts --lines 10000
```

State lives under `~/.local/share/prediff/<repo-id>/` (override with
`PREDIFF_STATE_DIR`).
