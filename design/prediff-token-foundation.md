# prediff — Token & Style Foundation

**Deliverable 1 of 3.** Grounded in the "Quiet Authority" restraint principle (near-monochrome chrome, muted diff colors, two strictly separate accents) crossed with the later blue/docs-tool pivot noted in the handoff doc. Sufficient for engineers to implement without further design input.

---

## 1. Type Scale

System sans for UI, monospace for all code/diff content. No display/serif typefaces — this is a working tool, not a marketing surface.

```css
--font-ui: -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", ui-monospace, Consolas, monospace;
```

| Token | Size / Line-height | Weight | Use |
|---|---|---|---|
| `--text-xs` | 12px / 16px | 400–500 | badges, timestamps, line numbers, keyboard hints |
| `--text-sm` | 13px / 18px | 400 | diff code, comment body, secondary UI text |
| `--text-base` | 14px / 20px | 400 | primary UI text, file tree rows, buttons |
| `--text-md` | 15px / 22px | 500 | section headers (e.g. "Guides", "Resources" equivalents) |
| `--text-lg` | 18px / 26px | 600 | sticky context header (file path + hunk) |
| `--text-xl` | 22px / 30px | 600 | session title / top-bar label only |

Diff code specifically always uses `--font-mono` at `--text-sm` (13px) — smaller than UI text is normal for diff tools and matches difit/GitHub precedent; density matters more than legibility-at-a-glance here since the reviewer is already close-reading.

---

## 2. Spacing Scale

4px base unit, used everywhere — no arbitrary pixel values in component styling.

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
```

Layout constants:
- File tree width: `280px` default, resizable, min `200px` / max `480px`
- Top bar height: `48px`
- Sticky context header height: `36px`
- Comment composer max-width: `680px` (readability cap, even on wide diffs)

---

## 3. Color Tokens

Two accents, kept strictly separate per the locked decision: **blue = ordinary UI actions**, **violet/indigo = agent activity only**. Never mix them — if a color in the UI could be read as "the agent did this," it must be the agent accent, full stop.

### 3.1 Light theme

```css
:root[data-theme="light"] {
  /* Surfaces */
  --bg-canvas: #ffffff;
  --bg-surface: #f7f8fa;
  --bg-surface-raised: #ffffff;
  --bg-surface-hover: #f0f1f4;
  --border-default: #e2e4e9;
  --border-subtle: #edeef1;

  /* Text */
  --text-primary: #0d0f14;
  --text-secondary: #5b6472;
  --text-tertiary: #8b93a1;
  --text-on-accent: #ffffff;

  /* Primary accent — ordinary UI actions */
  --accent-primary: #2563eb;
  --accent-primary-hover: #1d4ed8;
  --accent-primary-subtle: #eaf0fe;

  /* Agent accent — reserved, never used for ordinary UI */
  --accent-agent: #6366f1;
  --accent-agent-subtle: #eeeefd;

  /* Diff colors — deliberately muted/desaturated, not GitHub's saturated red/green */
  --diff-add-bg: #e9f5ec;
  --diff-add-text: #1a7f37;
  --diff-add-border: #cfe9d5;
  --diff-remove-bg: #fbebeb;
  --diff-remove-text: #b42318;
  --diff-remove-border: #f3d3d3;
  --diff-context-text: #5b6472;
  --diff-whitespace-bg: #f3f3f4; /* deemphasized, hidden by default per spec §3.2 */

  /* Status */
  --status-caution: #b45309;
  --status-caution-bg: #fef3c7;
  --status-error: #b42318;
  --status-error-bg: #fee4e2;
  --status-success: #1a7f37;
  --status-success-bg: #e9f5ec;

  /* Code block — stays dark even in light mode, per handoff note §3 */
  --code-block-bg: #16181f;
  --code-block-text: #e6e8eb;
}
```

### 3.2 Dark theme

```css
:root[data-theme="dark"] {
  /* Surfaces */
  --bg-canvas: #0a0b0d;
  --bg-surface: #111318;
  --bg-surface-raised: #16181f;
  --bg-surface-hover: #1c1f26;
  --border-default: #262a33;
  --border-subtle: #1c1f26;

  /* Text */
  --text-primary: #e6e8eb;
  --text-secondary: #9aa3b2;
  --text-tertiary: #676f7d;
  --text-on-accent: #ffffff;

  /* Primary accent */
  --accent-primary: #3b82f6;
  --accent-primary-hover: #60a5fa;
  --accent-primary-subtle: #16223d;

  /* Agent accent */
  --accent-agent: #818cf8;
  --accent-agent-subtle: #1e1f3a;

  /* Diff colors — muted, low-saturation, readable on near-black */
  --diff-add-bg: rgba(46, 160, 67, 0.13);
  --diff-add-text: #4ade80;
  --diff-add-border: rgba(46, 160, 67, 0.28);
  --diff-remove-bg: rgba(248, 81, 73, 0.13);
  --diff-remove-text: #f87171;
  --diff-remove-border: rgba(248, 81, 73, 0.28);
  --diff-context-text: #9aa3b2;
  --diff-whitespace-bg: #16181f;

  /* Status */
  --status-caution: #f0b429;
  --status-caution-bg: #2a2210;
  --status-error: #f87171;
  --status-error-bg: #2a1515;
  --status-success: #4ade80;
  --status-success-bg: #10261a;

  /* Code block — same dark surface in both themes */
  --code-block-bg: #16181f;
  --code-block-text: #e6e8eb;
}
```

---

## 4. Surface & Border States

| State | Treatment |
|---|---|
| Default row (file tree, comment) | `--bg-surface`, `--border-subtle` bottom hairline only |
| Hover | `--bg-surface-hover`, no border change (avoid layout shift) |
| Selected / current file | `--accent-primary-subtle` background, `--accent-primary` 2px left border |
| Focus (keyboard nav) | 2px `--accent-primary` outline, 2px offset — never rely on color alone |
| Disabled | 40% opacity, no hover state, cursor `not-allowed` |
| Agent-touched indicator | 6px dot, `--accent-agent`, positioned at file-tree row's right edge |

---

## 5. Component Styling Guidance

**Buttons**
- Primary ("Send Feedback", "Mark Ready"): filled `--accent-primary`, white text, 6px radius, `--space-2` `--space-4` padding
- Secondary ("Send this comment now", "Keep reviewing"): outline, `--border-default`, `--text-primary`
- Never use the agent accent on a clickable button — it's a status color only, reserved for indicators/labels, so it never gets mistaken for something the user is being asked to click

**Badges** (severity tags, status labels, method-style badges)
- Uppercase, `--text-xs`, `--space-1` `--space-2` padding, 4px radius, 1px border in the matching status color at low opacity — mirrors the `GET`/`POST` badge pattern from the reference screenshots

**Top bar**
- `--bg-surface-raised`, 1px bottom border `--border-default`, all controls vertically centered at `--space-3` gap
- Sync indicator (§6.5 of interaction spec) always rendered as text + small dot, never an icon-only control — the whole point is that it can't be missed or misread

**Sticky context header**
- `--bg-surface`, 1px bottom border, `--text-sm` monospace file path + `--text-xs` "hunk N of M" in `--text-tertiary`

**Revision banner**
- `--accent-agent-subtle` background, `--accent-agent` left border, never auto-dismisses — persists until the reviewer acts

**Comment composer**
- Inline, `--bg-surface-raised`, 1px `--accent-primary` border when focused, plain textarea, no rich-text toolbar (Markdown supported but typed, not buttoned)

---

## 6. What Deliberately Carries Over From the Docs-Site Reference

- Sidebar + main-pane split (file tree ↔ diff panel)
- Minimal sun/moon icon-only theme toggle, no label
- Search input with a keyboard-shortcut hint pinned to its right edge
- Muted secondary text against near-white/near-black surfaces, not mid-gray
- Bordered card pattern (no shadow) for any grouped-content block

## 7. What Does Not Carry Over

- The single-accent (green) system — prediff requires two accents, kept visually distinct at all times
- Decorative gradient washes in headers — Quiet Authority calls for flat surfaces; motion and color are reserved for meaning (agent activity, sync state), not atmosphere

---

*Deliverable 2 (hero screen mockup, light + dark) and Deliverable 3 (supporting wireframes) are built directly on these tokens.*
