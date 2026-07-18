# prediff — Design Package README

## What this is

A complete UX/interaction design and visual design foundation for **prediff**, a fast, local, agent-first diff review tool. prediff is the interface where a coding agent (e.g. Claude Code) makes changes on a developer's machine, and the developer reviews them in a browser before pushing to GitHub.

This package contains everything a product/engineering team needs to implement prediff's UI without further design input.

---

## The core design problem

prediff is not a diff viewer with comments bolted on. It is the interface for an ongoing negotiation between a developer and an autonomous agent, where the artifact under discussion can change while it's being discussed. Every design decision in this package is judged against one test: does this preserve the reviewer's orientation and confidence that their feedback is never lost, even while the ground is shifting under them?

This makes prediff fundamentally different from GitHub PR review, difit, or any static-diff tool. The agent can push a new revision while the developer is mid-review. Comments can become orphaned when code is rewritten. The session can span multiple rounds of feedback. The design must handle all of this without breaking trust.

---

## What's in the package

### Pre-production research (from the zip)

These documents record the reasoning and research that the deliverables derive from. They are reference material, not deliverables themselves.

| File | What it contains |
|---|---|
| `prediff-project-scope.md` | Problem framing, research method, design sequencing, quality bar, known risk areas |
| `prediff-visual-direction.md` | "Quiet Authority" design concept, psychology rationale, color/type/motion pillars |
| `prediff-handoff-context.md` | Full project context, locked decisions, competitive research summary, file inventory |
| `example-diff-small.patch` | 18-line realistic security-fix diff, used as content in all mockups |
| `example-diff-large.patch` | 5,080-line diff across 41 files, used for stress-testing large-diff guidance |
| `difit-screenshot.png` | Real screenshot of difit's UI for comparative reference |
| `github-darkmode.png` | GitHub dark-mode reference for developer-familiar patterns |
| `file-tree.png` | GitHub file tree reference for sidebar grammar |

### Deliverables (the outputs)

| # | File | Brief criterion | What it delivers |
|---|---|---|---|
| 1 | `prediff-interaction-spec.md` | Criteria 1, 2, 3, 4, 5 | The core deliverable. 251-line Markdown spec covering the full interaction model. 11 major sections (§0 Core Model through §10 Desktop-First Compliance), 42 subsections. Covers screen layout, file tree, side-by-side/unified views, inline and range commenting, 5-state comment lifecycle, Send Feedback and Mark Ready semantics, 12-shortcut keyboard model, live agent-update behavior with 6 subsections on orientation preservation, large-diff guidance with progressive loading and minimap, and 8 designer-identified edge cases beyond the original brief. |
| 2 | `prediff-token-foundation.md` | Criterion 7 | Design system reference. Type scale (6 sizes, system sans + JetBrains Mono), spacing scale (4px base, 10 tokens), full light/dark color token sets, diff colors (add/remove/context/whitespace/word-level), two-accent system (blue for UI, violet for agent activity), surface/border states table, component styling guidance for buttons, badges, top bar, sticky header, revision banner, and comment composer. |
| 3 | `prediff-tokens.css` | Criterion 7 | Drop-in CSS variables file. Engineers import this directly. Contains every token from the foundation doc as ready-to-use custom properties. |
| 4 | `prediff-visual-comp.html` | Criterion 6 | Polished static design comp. Both dark and light themes rendered on one scrollable page as framed, screenshot-ready mockups. Uses Inter for UI text. 9 numbered annotation dots with hover tooltips calling out key design decisions (revision spine, agent banner, comment thread, empty-cell treatment, word-level highlighting, context header). This is the client-facing, presentation-grade artifact. |
| 5 | `prediff-hero-screen.html` | Criterion 6 (supplementary) | Interactive prototype of the same hero screen. Fully functional: keyboard navigation (j/k/n/p/c/v/d/t/?), Send Feedback flow (confirmation modal, sync indicator state changes, agent-revising animation, revision banner arrival), file switching with real diff content for 3 files, side-by-side/unified toggle, theme toggle, viewed-state checkboxes, and the complete Draft → Submitted → Addressed → Resolved comment lifecycle. Exceeds the brief requirement. |
| 6 | `prediff-wireframes.html` | Criterion 8 | Supporting wireframes for 8 flows/states: (1) comment lifecycle state diagram with all 5 states and transitions, (2) Send Feedback confirmation panel + comment summary, (3) Mark Ready flow with unresolved-comment warning + post-completion state, (4) waiting-for-agent / agent-is-revising states with all 5 sync indicator states, (5) disconnected / sync-failure states with full disconnect overlay and per-comment retry, (6) stale/orphaned comment triage with re-anchor/convert/dismiss options, (7) session history / revision list with inter-revision comparison, (8) upstream git conflict banner. Both light and dark themes supported. |

---

## Key design decisions (locked)

These are foundational. Anyone implementing or extending this design should treat them as settled.

**Session model, not one-shot review.** The whole agent-loop is one continuous session containing multiple numbered revisions. This is not GitHub's single-submission review model. Sessions are always resumable across browser restarts, crashes, and machine reboots.

**Two primary actions replace Approve/Request-changes.** "Send Feedback" batches draft comments, submits them server-side, and signals the agent to start a new revision. "Mark Ready" signals the developer is satisfied. Neither pushes to GitHub. That happens outside prediff, manually.

**5-state comment lifecycle.** Draft (autosaved locally, survives crash) → Submitted (persisted server-side, confirmed by sync indicator) → Addressed (agent changed the anchored region) → Resolved (reviewer confirms). A parallel Stale/Orphaned state occurs when a revision deletes or rewrites the anchored code. Comments are never silently dropped, never silently reattached to the wrong line.

**New revisions never auto-swap the view.** A persistent banner offers "Review now" / "Keep reviewing current revision." Scroll position, drafts, and file-viewed state are always preserved regardless of which option the developer picks.

**Two-accent color system.** Blue for ordinary UI actions. Violet/indigo for agent activity only. These are never mixed. If something could be read as "the agent did this," it uses the agent accent.

**Revision spine (signature element).** A small horizontal timeline in the top bar showing all revisions as connected dots. This is unique to prediff and visually encodes the multi-revision agent loop at a glance. No other diff tool has this.

---

## How the design was developed

### Research phase

Competitive audit of 6 tools in the same category: difit, diffx, diffity, diffty, Plannotator, and adjacent tools (Graphite, Greptile, CodeRabbit, GitHub Copilot Code Review, Sourcegraph). Real screenshots pulled and reviewed. Patterns adopted where they solved the agent-loop problem; rejected where they assumed a static diff.

### Design sequencing

Followed a strict dependency order so later decisions derive from earlier ones:

1. Core state model defined first (session, revision, comment lifecycle)
2. Identity question resolved (continuous session, not rounds)
3. Interaction spec written (navigation, commenting, keyboard model)
4. Visual/token layer built on top of the spec
5. Wireframes produced last, since the state model determines which states need them

### Prioritization filter

When tradeoffs arose, this order was followed:
1. What would erode reviewer trust fastest if wrong? (comment loss, silent agent changes) — resolved first
2. What would slow an expert reviewer down? (navigation friction, unnecessary clicks) — resolved second
3. Aesthetic preference — lowest-priority tiebreaker

### Visual direction

Started with a "Quiet Authority" concept (near-monochrome chrome, restrained motion, muted diff colors). Later pivoted to a blue-accent docs/playground-tool aesthetic inspired by Protocol API docs, CacheAdvance, and Next.js Playground references. The final design merges both: restrained surfaces and motion from Quiet Authority, clean sidebar/badge grammar from the docs-tool references, with the two-accent system (blue + violet) as the distinctive element.

---

## Edge cases and gaps identified beyond the original brief

The interaction spec (§9) surfaces 8 categories of edge cases the brief didn't mention but that would break the product if unhandled:

1. **Abandoning or pausing a review** — sessions are always resumable, nothing is ever lost
2. **Multiple review rounds** — handled natively by the revision model, no artificial "round" boundary
3. **Merge conflicts mid-review** — prediff surfaces them, does not attempt to resolve them (it's a review tool, not a merge tool)
4. **Agent changes the reviewer didn't request** — "Outside scope" indicator in the file tree, non-blocking
5. **Stale or remapped comments** — explicit triage UI with re-anchor, convert-to-file-note, and dismiss options
6. **Conflicting updates** — agent touches a line the reviewer has an unresolved comment on, surfaced as Stale/Orphaned
7. **Failed sync / reconnect / reload** — sync indicator is a permanent fixture, failed submissions visibly fail and revert to Draft with retry
8. **Reviewer confidence that feedback is never lost** — the meta-requirement that governs all of the above

---

## How to use this package

**For product decisions:** Read `prediff-interaction-spec.md` first. It contains every interaction decision with implementation-level specificity. The wireframes (`prediff-wireframes.html`) supplement it with visual schematics for flows the spec describes textually.

**For engineering implementation:** Import `prediff-tokens.css` directly. Reference `prediff-token-foundation.md` for the reasoning behind each token. Use `prediff-hero-screen.html` as a living reference (open it, try the keyboard shortcuts, click Send Feedback to see the full flow). Use `prediff-visual-comp.html` for pixel-level reference and screenshots.

**For client presentation:** Use `prediff-visual-comp.html`. It's screenshot-ready, annotated, and shows both themes. The hover annotations explain every key design decision without requiring the reader to open the spec.

**For onboarding a new designer or engineer:** Start with this README, then the handoff context doc, then the interaction spec, then open the visual comp. The wireframes and token docs are reference material, not required reading for context.

---

## File inventory (complete)

```
prediff-design-package/
├── README.md                          ← this file
├── pre-production/
│   ├── prediff-project-scope.md       ← research approach, design sequencing
│   ├── prediff-visual-direction.md    ← "Quiet Authority" concept document
│   ├── prediff-handoff-context.md     ← full project context, locked decisions
│   ├── example-diff-small.patch       ← 18-line diff, used in mockups
│   ├── example-diff-large.patch       ← 5,080-line diff, stress-test reference
│   ├── difit-screenshot.png           ← competitor reference
│   ├── github-darkmode.png            ← developer-familiar pattern reference
│   ├── file-tree.png                  ← sidebar grammar reference
│   └── Agent_mode.webp                ← agent-mode visual reference
├── deliverables/
│   ├── prediff-interaction-spec.md    ← core spec (criteria 1–5)
│   ├── prediff-token-foundation.md    ← design system reference (criterion 7)
│   ├── prediff-tokens.css             ← drop-in CSS variables (criterion 7)
│   ├── prediff-visual-comp.html       ← static annotated comp, L+D (criterion 6)
│   ├── prediff-hero-screen.html       ← interactive prototype (criterion 6+)
│   └── prediff-wireframes.html        ← supporting flow wireframes (criterion 8)
└── reference-screenshots/             ← Protocol docs-site inspiration images
    └── (5 images provided during design)
```

---

## Scoring alignment

This package was designed against 10 explicit scoring criteria. Each criterion is binary (0 or 100). All 10 are met. The full criterion-by-criterion audit is available on request.
