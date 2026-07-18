# prediff — Interaction Design Specification

**Status:** v1 design spec. Written to be directly implementable by product/engineering without follow-up clarification. Grounded in the "Quiet Authority" visual direction (separate doc) and researched against difit, diffx, diffity, diffty, and GitHub/GitLab PR review conventions.

**Core design thesis:** prediff is not a diff viewer with comments bolted on. It is the interface for an ongoing negotiation between a developer and an autonomous agent, where the artifact under discussion can change while it's being discussed. Every decision below is judged against one test: *does this preserve the reviewer's orientation and confidence that their feedback is never lost, even while the ground is shifting under them?*

---

## 0. Core Model (read this before anything else)

### 0.1 Session, not single-shot review
A **session** is the whole arc from "agent launches prediff" to "developer is satisfied and pushes to GitHub themselves." A session is not GitHub's one-shot "review → merge" model — it's a continuous thread that can contain **multiple revisions**.

- A **revision** = one version of the diff, produced either by the agent's initial change or by the agent acting on feedback. Revisions are numbered (Revision 1, 2, 3...) and none are ever deleted — they're the session's history.
- Comments live inside the session, not inside a single revision. A comment is *anchored* to a specific revision's code but persists across revisions (see §4, comment lifecycle).
- The session ends when the developer explicitly marks it done (§5) or closes prediff. Sessions are always resumable — closing the browser tab or restarting the machine never destroys a session.

### 0.2 Why not GitHub's "start a review" batching model wholesale
GitHub batches comments into one review, submitted all at once, because the artifact (the PR) is static between reviews. Here the agent may already be idle and waiting — batching still makes sense (see §5.1) but the "review" is not a one-time gate, it's one turn in a back-and-forth. prediff's vocabulary reflects that: **"Send Feedback"** (this turn's batch goes to the agent) rather than GitHub's "Submit review," because "submit" implies finality this product doesn't have.

### 0.3 What "done" means here
prediff never pushes to GitHub itself and never merges anything — per the brief, review happens *before* anything reaches GitHub. So "done" has one meaning only: **the developer is satisfied and intends to push manually themselves.** The product's job ends at that signal. There is no separate "approve for merge" semantic — that would be GitHub's job, later, outside this tool.

---

## 1. Screen Layout

Single-screen, three-region layout, desktop-first (minimum supported width ~1280px; no mobile layout is in scope).

```
┌─────────────────────────────────────────────────────────────────────┐
│ Top bar: session label · sync status · revision indicator · Side-  │
│ by-side/Unified toggle · progress (N/M files viewed) · Send Feedback │
├───────────────┬───────────────────────────────────────────────────────┤
│               │  Sticky context header: current file path + hunk #  │
│  File tree    │───────────────────────────────────────────────────────│
│  (left rail,  │                                                       │
│  ~280px,      │  Diff panel (scrollable)                              │
│  resizable)   │  - hunk headers, line-by-line diff                    │
│               │  - inline comment threads render directly under       │
│  - search box │    the line(s) they're anchored to                    │
│  - tree/list  │                                                       │
│  - per-file   │                                                       │
│    badges     │                                                       │
│               │                                                       │
├───────────────┴───────────────────────────────────────────────────────┤
│ Bottom-left: keyboard hint strip (dismissible)   Bottom-right: change │
│ density minimap (only rendered above ~500 changed lines, see §7)      │
└─────────────────────────────────────────────────────────────────────┘
```

This mirrors GitHub's "Files changed" tab deliberately (Jakob's Law — see visual direction doc) with two structural additions GitHub has no equivalent for: the **revision indicator** in the top bar and the **sticky context header**, both required by the live-update problem (§6).

No separate "comments" sidebar — comment threads live inline, exactly where the code is, matching GitHub's model and avoiding a second place a developer has to check for what they said.

---

## 2. File Tree / Navigation

- Hierarchical tree grouped by directory, collapsible per folder.
- Each file row shows: change-type icon (added / modified / deleted / renamed), filename, `+N -N` line-count badges, a **viewed checkbox**.
- **Agent-touched-since-last-look** gets a small dot in the reserved agent-accent color (see visual direction) — the single most important navigational signal after a revision arrives.
- **Comment-count badge** per file (distinguishes resolved vs. unresolved counts, e.g. "2 open").
- Filter/search box at the top of the tree: fuzzy filename match, live-filters the tree. Supports typed filters (see §7.5 for the large-diff filter vocabulary).
- Files the tool auto-collapses by default (generated files, lockfiles, deleted files — see §7.1) still appear in the tree, just visually deemphasized (muted row, collapsed content) — never hidden entirely. **A developer must always be able to see the full list of files the agent touched.** This directly defends against silent agent scope creep (§9.4).
- Clicking a file scrolls the diff panel to it. Keyboard equivalents in §8.

---

## 3. Diff Views

### 3.1 Side-by-side vs. unified
Both are supported; **side-by-side is the default** (matches GitHub default, matches the wide desktop-first canvas). Toggle lives in the top bar, persists as a user preference across sessions (not per-session).

### 3.2 Standard diff mechanics
- Old/new line numbers both shown in side-by-side; unified shows a single gutter with +/- markers.
- Word-level highlighting within a changed line (not just whole-line green/red) — reduces scanning time on small edits, which is most of what agents produce.
- Context lines default to 3 above/below a change (matches `git diff` default and difit's precedent); **"Expand context"** control at the top/bottom of each hunk to reveal more surrounding code, up to the full file.
- Whitespace-only changes are visually deemphasized (toggle to show/hide, default: hidden) — agents occasionally reformat, and this must not read as a "real" change requiring review attention.
- Renames are detected and shown as a single "renamed" header rather than a full delete+add pair, with a content-diff below only if the content also changed.
- Binary/image files get a dedicated side-by-side image comparison view, not a "binary file not shown" dead end.

### 3.3 Hunk-level focus model
The diff panel's fundamental unit of navigation is the **hunk** (a contiguous block of changes), not the line and not the file. This is what the keyboard model (§8) and the sticky header (§6.2) are built around — it's the right grain for "where am I" because it's large enough to be meaningful and small enough to keep orientation cheap.

---

## 4. Commenting

### 4.1 Creating a comment
- **Inline (single line):** hovering a line's gutter reveals a `+` button.
- **Range:** click-drag across contiguous lines selects a range; releasing opens the composer anchored to that range.
- Composer is a plain textarea (Markdown supported), positioned inline directly beneath the anchored line(s) — never a modal, never a detached sidebar. Submit: `Cmd/Ctrl+Enter`. Cancel: `Esc`.

### 4.2 Comment lifecycle
This is the single most load-bearing state machine in the product. Five states:

| State | Meaning | Visual treatment |
|---|---|---|
| **Draft** | Written, not yet sent to the agent. Exists only in this reviewer's view. | Neutral outline, small "draft" label |
| **Submitted** | Sent to the agent as part of a "Send Feedback" batch (§5.1). Persisted server-side the instant it's sent — not on some later save. | Solid outline, no label (this is the "normal" resting state) |
| **Addressed** | The agent's most recent revision includes a change in the vicinity this comment was about. The tool does **not** claim to know if the agent got it *right* — only that something changed in response. | Agent-accent colored label: "Agent responded — review this" |
| **Resolved** | The reviewer confirms the feedback was satisfactorily handled. Thread collapses to a single collapsed line, reopenable anytime. | Muted, collapsed, checkmark |
| **Stale / Orphaned** | The code this comment was anchored to no longer exists in the current revision, or the anchor can't be confidently relocated. See §6.4. | Caution-accent (amber) label: "Needs your attention" |

Transitions: Draft → Submitted (via "Send Feedback," §5.1) → Addressed (automatic, set when a new revision touches the anchored region) → Resolved (manual, reviewer action) or reopened back to Submitted if the reviewer isn't satisfied. Stale/Orphaned can happen to a comment in *any* post-Draft state when a new revision arrives (§6.4) and is resolved by the reviewer either re-anchoring it manually or dismissing it.

**Persistence guarantee:** Draft comments autosave (debounced, ~1s) to the local session store the moment typing pauses — never lost on crash or reload. Submitted comments are written server-side synchronously as part of the "Send Feedback" action, confirmed by the sync indicator (§6.5) before the action is considered complete. There is never a "you'll lose this if you don't hit submit" moment — drafts are safe well before submission, and submission itself is confirmed, not fire-and-forget.

### 4.3 Severity / intent tagging (adopted from category research)
Optional single-select tag per comment: **Must fix / Suggestion / Question / Nit** (pattern validated against diffity's approach). Not required to submit a comment — defaults to untagged — but lets a developer signal priority to the agent without writing "please prioritize this" in every comment body.

---

## 5. Finish Review / Request Changes Semantics

Two primary actions, always visible in the top bar, both disabled (grayed, with a tooltip explaining why) when there's nothing to act on:

### 5.1 "Send Feedback"
Batches every **Draft** comment into one submission, sets them all to **Submitted**, and signals the agent to start a new revision. This is the primary loop-closing action, used possibly many times per session. Matches GitHub's "start a review → submit" batching instinct (avoid interrupting the agent once per comment) while being named for what it actually does here — feeding the agent, not gating a merge.

A secondary, less prominent option, **"Send this comment now,"** exists per-comment for the rare case a reviewer wants to unblock the agent on one urgent item without waiting to finish reading the rest of the diff.

### 5.2 "Mark Ready"
Signals the developer is satisfied and does not expect further agent iteration. This does **not** push anything or contact GitHub — it's a session-completion signal only, confirmed with a short summary (open comment count, if any, with a warning if marking ready with unresolved comments still open — allowed, but flagged, since a developer may legitimately decide something isn't worth blocking on). After marking ready, the session is archived but remains viewable/reopenable; prediff's UI makes clear the next step (pushing) happens outside the tool.

### 5.3 What's deliberately *not* offered
No "Request changes" as a distinct blocking action separate from "Send Feedback" — unlike GitHub, there's no separate party whose merge is being gated, so the extra state would just be duplicate vocabulary for the same action.

---

## 6. Live Agent Update Behavior

This is the section that most differentiates prediff from a static diff viewer, and the one every other design decision in this document was built to support.

### 6.1 Arrival of a new revision
When the agent pushes a new revision while the developer is actively reviewing, **nothing about the current view changes automatically.** A persistent, non-blocking banner appears at the top of the diff panel (not a toast — toasts can be missed and this must never feel like it could be missed): *"Agent pushed Revision 3 — [Review now] [Keep reviewing Revision 2]."*

- Scroll position, open/collapsed hunk states, current file selection, and all draft comments are preserved exactly regardless of which option the developer picks.
- If the developer keeps reviewing the old revision, that remains fully valid — comments made against Revision 2 are simply tagged as such and reconciled against Revision 3 once the developer does switch (see §6.4).

### 6.2 Preserving orientation across a refresh
The **sticky context header** (file path + hunk position, e.g. "src/auth.py — hunk 3 of 7") stays fixed at the top of the viewport at all times, including immediately after switching to a new revision, so a "where was I" moment never requires re-scanning the file tree. Switching revisions animates gently (per the visual-direction motion principle) rather than snapping instantly, so the eye can track what moved.

### 6.3 Reviewer controls the timing, always
Auto-apply of incoming revisions is **off by default.** The new revision is queued and clearly signaled but never forcibly swaps the view out from under an actively-scrolling developer. A settings toggle allows developers who want auto-apply (e.g., during a fast solo iteration loop) to opt in explicitly.

### 6.4 Stale and remapped comments
When a revision arrives and the developer applies it, every existing comment is checked against the new code:

- If the anchored lines are unchanged or shifted only by line-number offset (e.g., code above it grew), the comment **silently follows** — this is the common case and must require zero reviewer attention.
- If the anchored region was modified, the comment is marked **Addressed** (§4.2) — visible, not silent, but not alarming either.
- If the anchored region was deleted or changed beyond confident matching, the comment becomes **Stale/Orphaned**, surfaced in a dedicated "Needs your attention" list accessible from the top bar (badge count), never silently dropped and never silently reattached to the wrong line. The reviewer resolves this by re-anchoring it manually to the new location, converting it to a general file-level note, or dismissing it.

### 6.5 Sync status indicator
Always visible in the top bar, one of: **Synced** (neutral) · **Saving...** (neutral, brief) · **Agent is revising** (agent-accent) · **Offline — reconnecting** (caution) · **Sync failed — retry** (error, rare by design — see visual direction). This is a permanent fixture, never a dismissible toast, because its entire job is to remove any doubt about whether feedback landed.

### 6.6 Conflict handling
Two distinct conflict types, handled differently:

- **Local double-write conflict** (agent revision touches a region the developer has an open, unresolved comment on, in a way that makes the comment's request ambiguous — e.g., the exact lines were deleted entirely): surfaced as a Stale/Orphaned comment per §6.4, not a special "conflict" UI — it's the same underlying mechanism.
- **Upstream git conflict** (the local branch's merge-base diverged from `origin/main` while the session was in progress — a real git merge conflict, not an agent-vs-reviewer disagreement): prediff does **not** attempt to auto-resolve this. It surfaces a blocking banner on the affected file(s): *"This file has upstream changes that may conflict. Resolve in your editor/terminal before continuing review here."* prediff is a pre-push review tool, not a merge tool — auto-resolving conflicts is out of scope and would undermine the trust the whole product depends on.

---

## 7. Large-Diff Guidance (≈5,000–50,000 changed lines)

Tested conceptually against a generated 5,080-line, 41-file example diff (one large generated-config rewrite + many near-identical small handler edits) — a realistic large-diff shape, not a hypothetical one.

### 7.1 Default collapse rules
Collapsed by default, shown as a single muted row (never hidden from the file tree — see §2):
- Deleted files
- Generated files (lockfiles, `*.min.js`, source maps, framework-generated code) — detected by filename pattern and `@generated`/`DO NOT EDIT` header content, matching difit's validated existing ruleset rather than reinventing it
- Any single file whose diff exceeds ~800 changed lines by itself, regardless of type — a file that large is triage material first, line-by-line material second

Everything else (the ordinary, reviewable changes) stays expanded by default — the collapse rule is about protecting attention from *noise*, not from *volume* generally.

### 7.2 Sticky and contextual elements
- Sticky context header (§6.2) becomes load-bearing at this scale — it's the only thing standing between the reviewer and total disorientation once scroll position no longer maps to any file-tree highlight the eye can track.
- File tree auto-scrolls to keep the current file visible/highlighted as the developer scrolls the diff panel (bidirectional sync between tree and panel).

### 7.3 Minimap / navigation aid
Recommended: a lightweight **change-density strip** in the scrollbar gutter (conceptually like VS Code's minimap, but density-only — not a rendered-code minimap, which would be expensive to compute and low-value at this scale). It shows: hunk locations as tick marks, comment markers as small dots, current viewport position as a highlighted band. Only rendered above ~500 changed lines total — below that threshold it's visual noise, not an aid.

### 7.4 Progressive loading
- The full file list and change-stats load immediately (needed for the file tree and progress indicators), but **diff content renders on demand** — a file's line-by-line diff is only rendered into the DOM when it scrolls into view or is explicitly selected. Virtualized rendering (windowing) for any single very large file's line list.
- This is a hard requirement above ~5,000 lines: rendering the entire diff into the DOM at once is the most common way large-diff tools become unusable, independent of any visual design decision.

### 7.5 Search / filter / reviewed-state patterns
Filter box in the file tree supports typed filters, not just fuzzy filename match:
- `is:unviewed`, `is:commented`, `is:agent-touched`, plus free-text filename fuzzy match, combinable.
- Full-text search across diff content (not just filenames) — async-indexed on load, since at 50k lines a synchronous search would visibly block.
- Bulk action: **"Mark all generated/collapsed files as viewed"** — a one-click acknowledgment for the noise files, distinct from actually reviewing them, so the progress indicator can reflect "I've triaged everything" without falsely implying line-by-line reading happened.
- Global progress indicator in the top bar (e.g., "12/41 files viewed") is always visible, giving the single most important large-diff reassurance: *how much is left.*

---

## 8. Keyboard Navigation Model

Deliberately small — enough to make an expert reviewer fast, not so much it needs its own manual.

| Key | Action |
|---|---|
| `j` / `k` | Next / previous hunk |
| `n` / `p` | Next / previous file |
| `c` | Comment on the currently focused line/hunk |
| `Cmd/Ctrl+Enter` | Submit the open comment composer |
| `Esc` | Cancel the open composer, or close the currently open panel |
| `v` | Toggle "viewed" on the current file |
| `]` / `[` | Next / previous unresolved comment (jumps across files if needed) |
| `/` | Focus the file-tree search/filter box |
| `d` | Toggle side-by-side / unified |
| `?` | Show the keyboard shortcut overlay |

No vim-style modal editing, no chorded combinations beyond `Cmd/Ctrl+Enter` — the model favors single-key discoverability over exhaustive coverage.

---

## 9. Edge Cases & Gaps (designer-identified, beyond the initial brief)

Each of these was deliberately elicited (per the project's research approach) rather than discovered incidentally.

### 9.1 Abandoning or pausing a review
Sessions are always resumable. Closing the browser tab, restarting the machine, or walking away for days does not lose anything — the session, its revisions, and every comment (draft, submitted, or resolved) persist server-side (drafts included, per §4.2). Reopening prediff for the same working directory resumes the exact session, scroll position included where feasible, file-viewed-state included always.

### 9.2 Multiple review rounds
Handled natively by the revision model (§0.1) — there's no artificial "round" boundary to design around. A developer can send feedback, review a new revision, send more feedback, and repeat indefinitely within one session. The session's revision history is viewable as a simple numbered list (Revision 1, 2, 3...) with the option to view "what changed since revision N" as its own diff-of-diffs, collapsed/optional, for a developer who wants to sanity-check only the newest changes rather than re-reading everything.

### 9.3 Merge conflicts mid-review
Covered in §6.6 — treated as a distinct upstream-git-conflict case, surfaced clearly, never auto-resolved by prediff.

### 9.4 Agent changes the reviewer did not request
The file tree never hides any file the agent touched (§2) — this is the primary defense. Additionally, if the agent has a stated task/scope (e.g., passed in by the launching skill as "fix the login bug"), files touched outside an inferable scope get a visible, non-blocking **"outside stated scope"** indicator in the file tree — informational, not a block, since agents sometimes legitimately need to touch adjacent files. This turns "did the agent go off and do something I didn't ask for" from an implicit anxiety into an explicit, glanceable answer.

### 9.5 Stale or remapped comments
Fully covered in §6.4 — the core design commitment is that a comment is never silently dropped and never silently reattached with false confidence. Ambiguity always surfaces as a visible "needs your attention" item, not a guess presented as certainty.

### 9.6 Conflicting updates
If two comments end up addressing the same lines in ways that could conflict with each other (e.g., reviewer commented twice, or a resolved comment's guidance contradicts a later draft comment), no automatic reconciliation is attempted — both remain visible in the thread; the developer is the sole authority on reconciling their own feedback.

### 9.7 Failed sync / reconnect / reload
The sync indicator (§6.5) is the front line here. On a failed submission, the action visibly fails (does not silently appear to succeed) and the affected comments revert to Draft with a clear retry affordance — never left in an ambiguous "did that go through" state. On full disconnect (server unreachable — a real possibility for a local tool if the launching process dies), the entire UI enters a clearly labeled **"Disconnected"** state overlaying the top bar, with all local drafts preserved and an automatic reconnect attempt; reconnection restores the exact prior view.

### 9.8 Reviewer confidence that feedback is never lost (the meta-requirement)
This isn't a separate feature — it's the sum of §4.2 (draft autosave + synchronous submission confirmation), §6.5 (permanent sync indicator), and §9.1 (full session persistence). No single screen "solves" this; it's a property that has to hold across every state transition in this document, which is why it was treated as the top-level test for every decision above rather than a checklist item at the end.

---

## 10. Desktop-First / Developer-Familiar Compliance Note

This entire spec assumes a minimum ~1280px desktop browser viewport, no responsive/mobile layout, and deliberately reuses GitHub's PR-review vocabulary and layout grammar everywhere the agent-loop problem doesn't force a deviation (see visual direction doc, §4, for the explicit list of where and why it diverges). A developer who has used GitHub PR review should be able to use prediff's core loop (browse files, read a diff, leave a comment) with zero onboarding; the only genuinely new concepts they need to learn are the revision indicator, the sync indicator, and the "Send Feedback" / "Mark Ready" pair — three concepts, each directly visible and labeled in plain language rather than jargon.
