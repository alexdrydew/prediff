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
and sends you batches of line comments; you fix and iterate. All state is
persisted on disk by a background daemon — **no command here can lose review
data, and every command except `wait` returns immediately.**

## The loop

### 1. Open a review session

```bash
prediff open working --scope "<the task you were asked to do>" --json
```

Ranges: `working` (everything vs HEAD — the usual choice), `staged`, `HEAD`
(last commit), or any `A..B`. `--scope` is a one-line statement of your task
("fix the login redirect bug") — the UI uses it to flag files you touched
outside the stated scope, so always pass it. Output:

```json
{"session_id": "…", "url": "http://localhost:4966", "files": 12, "additions": 340, "deletions": 61, "revision": 1, "session_state": "reviewing"}
```

Tell the developer the URL and what you'd like them to look at. `open` is
idempotent — re-running refreshes the diff in place.

### 2. Wait for feedback — timeouts are normal

```bash
prediff wait --timeout 240 --json
```

Returns as soon as something happens, with exit code:

- `0` — developer clicked **Mark Ready**: they're satisfied and the session
  is complete (they push manually themselves; nothing else to do here).
- `2` — a **feedback batch** arrived ("Send Feedback" or a single
  "send now" comment). The JSON's `comments` array is exactly that batch —
  start addressing it now.
- `3` — **timeout**. Nothing lost — state is on disk. Either `wait` again,
  or end your turn telling the developer the review is open; you (or a
  future session) can pick it up anytime with `prediff comments --json`.

Never treat exit 3 as an error. Never ask the developer to hurry. Note the
developer may still be typing more comments as drafts — drafts are private
to them and never appear in your output or wake `wait`; you only ever see
comments they explicitly sent.

### 3. Read and address comments

```bash
prediff comments --json --unresolved
```

Each comment has `id`, `file`, `line`/`end_line`, `side` (`old`/`new`),
`text`, an optional `tag` (`must-fix` / `suggestion` / `question` / `nit` —
treat `must-fix` as top priority), `state`, and `replies`. States you will
see (drafts are always excluded):

- `submitted` — sent to you, not yet acted on. Address it.
- `addressed` — your last refresh changed the code near this comment; the
  developer is re-checking it. If you actually handled it, resolve with a
  reply; otherwise keep working on it.
- `orphaned` — the code it pointed at no longer exists in the current
  revision. Check whether your changes already covered it; resolve with a
  reply explaining either way.
- `resolved` — done.

For each comment you act on: make the fix, then

```bash
prediff refresh --json                 # recompute the diff → new revision, UI updates live
prediff resolve <comment-id> --reply "Fixed: <what you did>" --json
```

Resolve with a reply every time — the developer sees your reply threaded
under their comment in the UI. If you *disagree* with a comment, reply via
`resolve --reply` explaining why, or leave it open and raise it in chat.
Filter with `--state submitted` / `--state addressed` etc. when triaging.

### 4. Repeat until done

Loop `wait` → fix every comment in the batch → `refresh` → `resolve` until a
`wait` returns exit 0 (Mark Ready). Aim for zero unresolved comments before
that, but Mark Ready is the developer's call and ends the session either way.

## Recovering / checking state anytime

```bash
prediff status --json     # session snapshot: session_state, revision, counts by state
prediff comments --json   # everything you're allowed to see, including resolved
```

The daemon outlives your process (idle TTL ~4h). If your session/context was
interrupted mid-review, just run `prediff status --json` — nothing was lost.
Every diff recompute is a numbered **revision**; old revisions stay viewable
in the UI, so refreshing is always safe and never yanks the view out from
under the developer.

## Rules

- Surface the review URL to the developer immediately after `open`.
- Always pass `--scope` on `open` so out-of-scope files are flagged honestly.
- Prefer several short `wait` calls over one long one; between them you can
  do other work the developer asked for.
- Address every `submitted` and `addressed` comment in a batch before going
  idle — don't cherry-pick.
- Don't `prediff stop` unless the developer says the review is over.
- Don't push/commit "review fixes" upstream until a `wait` returns Mark
  Ready (exit 0), unless the developer says otherwise.
