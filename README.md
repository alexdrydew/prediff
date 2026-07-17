# prediff

A fast, local, agent-first diff review tool. A coding agent makes changes,
starts prediff, and the developer reviews the diff in the browser — leaving
line comments the agent then acts on — before anything reaches GitHub.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design.

## Status

Phase 1: backend core (diff engine, durable comment store, daemon, CLI) plus a
temporary placeholder UI. The real frontend is being designed separately.

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
