---
name: prediff-review
description: >
  Present your local code changes to the developer for review in a browser
  diff UI, then act on their line comments — all before anything is pushed.
  Use after completing a nontrivial code change when the developer should
  review it, or when they ask to "review the diff" / "show me the changes".
  Never lose feedback: all comments are persisted server-side; timeouts are
  normal and safe.
---

# prediff — present a diff for developer review

You made changes; the developer reviews them in a GitHub-PR-style browser UI
and leaves line comments; you fix and iterate. All state is persisted on disk
by a background daemon — **no command here can lose review data, and every
command except `wait` returns immediately.**

## The loop

### 1. Open a review session

```bash
prediff open working --json
```

Ranges: `working` (everything vs HEAD — the usual choice), `staged`, `HEAD`
(last commit), or any `A..B`. Output:

```json
{"session_id": "…", "url": "http://localhost:4966", "files": 12, "additions": 340, "deletions": 61}
```

Tell the developer the URL and what you'd like them to look at. `open` is
idempotent — re-running refreshes the diff in place.

### 2. Wait for feedback — timeouts are normal

```bash
prediff wait --timeout 240 --json
```

Returns as soon as something happens, with exit code:

- `0` — review **submitted**. JSON contains final state + all comments.
- `2` — **new comments** arrived (review still in progress). Start
  addressing them now; don't wait for submission.
- `3` — **timeout**. Nothing lost — state is on disk. Either `wait` again,
  or end your turn telling the developer the review is open; you (or a
  future session) can pick it up anytime with `prediff comments --json`.

Never treat exit 3 as an error. Never ask the developer to hurry.

### 3. Read and address comments

```bash
prediff comments --json --unresolved
```

Each comment has `id`, `file`, `line`/`end_line`, `side` (`old`/`new`),
`text`, `state` (`open` / `resolved` / `outdated`), and `replies`.

For each open comment: make the fix, then

```bash
prediff refresh --json                 # recompute diff, UI updates live
prediff resolve <comment-id> --reply "Fixed: <what you did>" --json
```

Resolve with a reply every time — the developer sees your reply threaded
under their comment in the UI. If you *disagree* with a comment, reply via
`resolve --reply` explaining why, or leave it open and raise it in chat.

`outdated` comments failed to re-anchor after the diff changed (still
visible to the developer). Check whether your changes already addressed
them; resolve with a reply either way.

### 4. Repeat until done

Loop `wait` → fix → `refresh` → `resolve` until a `wait` returns exit 0
(submitted) **and** `prediff comments --json --unresolved` is empty.

## Recovering / checking state anytime

```bash
prediff status --json     # session snapshot: state, counts, generation
prediff comments --json   # everything, including resolved
```

The daemon outlives your process (idle TTL ~4h). If your session/context was
interrupted mid-review, just run `prediff status --json` — nothing was lost.

## Rules

- Surface the review URL to the developer immediately after `open`.
- Prefer several short `wait` calls over one long one; between them you can
  do other work the developer asked for.
- Don't `prediff stop` unless the developer says the review is over.
- Don't push/commit "review fixes" upstream until the review is submitted
  and unresolved comments are zero, unless the developer says otherwise.
