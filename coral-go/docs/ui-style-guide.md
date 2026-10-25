# Coral UI style guide

This is the reference for new frontend work and visual consistency changes. Apply it to the existing Coral workspace. Keep the current navigation, sidebar and resize behavior, panel layout, composer footprint and controls, and inline Files preview. A former stronger structural redesign was rejected; it is not a source of layout requirements.

**Status:** the colors, font families, spacing, radii and basic font sizes below already exist in [`variables.css`](../pkg/frontend/static/css/variables.css). Role names, component contracts and any new tokens marked **target** are conventions to implement incrementally; they do not mean every current surface complies. For source-level discrepancies and the user screenshots, see [the consistency audit](../../tests/design/coral-workspace-refresh/CONSISTENCY-AUDIT.md). The CSS entry point imports `variables.css`, then base/components, then surface CSS and mobile overrides in [`style.css`](../pkg/frontend/static/style.css).

## Identity and theme

- Use Coral's configured `--font-sans` for workspace UI and `--font-mono` for code, diffs, file paths where alignment matters, and raw output. The current defaults are Plus Jakarta Sans and the system monospace stack. Respect user-selected font settings and inherited font variables; do not hardcode a new family in a component. Terminal rendering keeps its own user font and size settings.
- Use `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-hover`, `--border`, `--text-primary`, `--text-secondary`, `--accent`, `--accent-dim`, `--success`, `--warning`, and `--error`. Their values differ in dark/light mode and may be changed by custom themes. Do not hardcode today's blue or status hex values in components.
- Use color for emphasis, alongside text/shape for selected, busy, warning, error, and task status. Do not use `--text-muted` for essential metadata or actionable controls. Check contrast after a theme override.

## Type roles

All sizes are CSS pixels at the browser's default zoom. The exact role is chosen by meaning, not by surface.

| Role | Size / line height / weight | Token mapping and use |
| --- | --- | --- |
| Page title | 20px / 1.3 / 600 | **Target** `--type-page-size: 20px`; main page/dialog workspace title. |
| Section title | `--fs-xl` 16px / 1.4 / 600 | Major section and dialog heading. |
| Item title | `--fs-lg` 14px / 1.4 / 600 | Card, artifact, task, and file group title. |
| Body / chat prose | `--fs-lg` 14px / 1.5 / 400 | Reading text, descriptions, assistant/human prose. Preserve existing rich text hierarchy and user font choices. |
| UI text / control | `--fs-md` 13px / 1.4 / 500 | Navigation, buttons, input value, file row name, compact explanatory copy. Use 600 for selected tab or emphasized item name. |
| Metadata / helper | `--fs-base` 12px / 1.4 / 400 | Timestamps, file type/size, task attribution, helper and tool summary text. Use 500 for table headers and labels. |
| Badge / nonessential count | `--fs-sm` 11px / 1.3 / 600 | Compact badges/counts only; a badge cannot be the sole source of status. |
| Code / terminal | User setting or current code style / 1.4 or terminal setting / 400 | `--font-mono`; preserve syntax, indentation, wrapping, and terminal grid. No blanket UI font rule on xterm, editors, `pre`, or code. |

`--fs-xs` (10px) is already defined. It is not a default role for new readable UI. When adapting existing 9–11px labels, raise essential information to metadata size instead of adding another tiny size.

## Spacing, shape, and icons

Use existing `--space-xs: 4px`, `--space-sm: 6px`, `--space-md: 8px`, `--space-lg: 12px`, `--space-xl: 16px`, `--space-2xl: 24px`. Use 4px between an icon and short label, 8px between related controls, 12px as standard row padding, 16px between groups, and 24px between independent sections. Apply these inside existing containers; do not alter panel widths or the composer height by default.

Use `--radius-md: 6px` for buttons/fields, `--radius-lg: 8px` for cards, and `--radius-xl: 12px` for dialogs. Text tabs have no enclosing border or pill radius. Use a 1px `--border` divider for table rows and panel separation. Avoid stacking multiple borders around one action.

Use the existing Material Icons family for functional icons. The standard glyph is 18px, dense inline glyph 16px, and prominent navigation glyph 20px. An icon-only button has a 32px square visual box on desktop and a 44px minimum target on touch layouts. Use one icon for one meaning across surfaces, but keep a visible text label for primary actions and ambiguous actions such as Preview, Download, Save, and Send. The chat Stop control is the documented icon-only exception below. Give every icon-only button an accessible name; `title` is supplemental, not the name. Decorative emoji may remain content. Replace raw action glyphs (for example star/refresh) only when the same semantics and keyboard behavior are retained.

## Component contracts

| Component | Target rule | Existing anchor |
| --- | --- | --- |
| Standard button | 36px minimum height; 13px/500 text; 8px vertical and 12px horizontal padding; 6px radius. Primary uses theme accent and readable on-accent text. Danger uses semantic error and a text label. | `.btn` in `css/components.css`; newer local buttons in `css/agentic.css`. |
| Compact/quiet action | 32px minimum height; 13px/500 text; 4px vertical and 8px horizontal padding; transparent border at rest, hover surface. Use beside list rows and preview toolbar; keep explicit Preview/Download. | `.team-artifacts-action` and `.inline-preview-mode-btn` in `css/agentic.css`. |
| Text tab | 36px minimum height; 13px/500 text; no surrounding box; 2px accent underline and 600 weight when selected. Preserve a distinct hover and focus state. | `.top-nav-tab`, `.agentic-tab`, `.files-source-button`. |
| Field | 36px minimum height; 13px value; visible label above; 8px vertical and 12px horizontal padding, 6px radius, themed border/surface. Help/error at 12px, associated with field. | Modal inputs in `css/components.css:559-585`; composer is a size exception. |
| Status / metadata | Status text at 12px/500 with icon or word; semantic token for status; metadata at 12px/400 with `--text-secondary`. | Task board in `css/agentic.css`, workflow status in `css/workflows.css`. |

These dimensions are **target conventions**, not a directive to shrink the composer, sidebar, file preview, or existing accessible hit targets. At pointer-coarse/mobile widths, controls and tab targets have at least 44px hit height, including quiet actions. For an icon embedded in a text button, size the icon separately; do not enlarge text via the icon font.

### Interaction states

- **Default:** text and border are legible in both themes. **Hover:** `--bg-hover` plus an appropriate text/border cue; hover must not reveal the only way to act. **Pressed/selected:** accent underline or border plus selected text and `aria-selected`/`aria-pressed` as appropriate.
- **Keyboard focus:** 2px solid `--accent` with 2px offset, or an inset offset where clipping requires it. Never remove focus without a replacement. Use `:focus-visible`; match the global rule in `css/base.css`.
- **Disabled:** preserve the label; use native `disabled`, no pointer action, and readable disabled contrast. Do not use opacity alone for unavailable status. **Loading:** keep the control's width/label context, set `aria-busy` on the region or control as appropriate, prevent duplicate activation, and announce completion/error in a status region. **Error:** include plain-language text and a recoverable action; color alone is insufficient.
- Motion is subtle and optional; respect `prefers-reduced-motion: reduce`. Maintain stable layout during hover, loading, and active changes.

## Files and artifact patterns

The Files panel has four sources: **Files, Browse, Artifacts, Team Artifacts**. They are text tabs with a selected underline, in the existing source strip. Keep all four reachable and visibly labeled; allow horizontal scrolling on narrow widths rather than hiding sources or abbreviating them ambiguously. Use the existing `tablist`/`tab`/`tabpanel` pattern: `aria-selected` marks the active tab, the selected tab has `tabIndex=0`, other tabs have `tabIndex=-1`, and Left/Right/Home/End move focus and selection. Each tab's `aria-controls` and panel's `aria-labelledby` must resolve to the correct live element, including inside a preview. Do not add `aria-pressed` to a `role=tab` button. Keep source navigation available during inline preview. Back returns to the prior list; Preview, Edit/source, Diff, and Download remain clear. HTML Preview keeps its sandbox and opaque origin; style work never grants scripts or parent access.

Artifact listings use a **semantic table** with columns in this order: **Name, Type, Size, Task, Created, Actions**. Use `<table>`, `<thead>`, `<th scope="col">`, `<tbody>`, and one `<tr>` per artifact. Name is the primary 14px/600 link or button; type, size, task, and date are separate 12px cells. Use a stable display type and human-readable size; show unavailable values as an em dash with an accessible explanation when needed. Created uses a visible localized date/time and a machine-readable `<time datetime>`. Task uses a link when navigation exists, otherwise plain text. Actions contain explicit Preview and Download/Open labels; unavailable actions have text explaining why. Preserve the full name as accessible text and a tooltip where visual truncation is used. A `Details` disclosure can hold secondary URI/reference data, but must not replace the six primary columns.

On narrow screens, first make the table's region horizontally scrollable with a visible affordance and keep headers associated with cells. A stacked row pattern is acceptable only if each field retains a visible label and native table semantics are still understandable to assistive technology. Do not merge Type/Size/Task/Created into one unlabeled prose string. Do not collapse away Actions or the four source tabs. Long names wrap at sensible break points; avoid expanding the whole workspace.

```html
<div class="artifact-table-scroll" tabindex="0" aria-label="Team artifacts table, scroll horizontally for more columns">
  <table class="artifact-table">
    <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Size</th><th scope="col">Task</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead>
    <tbody><tr>
      <td><button type="button">Build report</button></td><td>JSON</td><td>24 KB</td>
      <td>Task #2506</td><td><time datetime="2026-10-06T04:44:00Z">Oct 5, 9:44 PM</time></td>
      <td><button type="button">Preview</button> <a href="/api/artifacts/example" download>Download</a></td>
    </tr></tbody>
  </table>
</div>
```

The example shows structure only; production URLs, data, local time and accessibility labels come from the renderer. Keep the scroll wrapper keyboard focusable only when it actually overflows, or make overflow discoverable without creating an unnecessary Tab stop.

```css
/* Target pattern; integrate with existing selectors and theme variables. */
.files-source-button { min-height: 36px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-secondary); font: 500 var(--fs-md)/1.4 var(--font-sans); }
.files-source-button[aria-selected="true"] { border-bottom-color: var(--accent); color: var(--text-primary); font-weight: 600; }
.artifact-table-scroll { max-width: 100%; overflow-x: auto; }
.artifact-table { width: 100%; border-collapse: collapse; }
.artifact-table th, .artifact-table td { padding: var(--space-lg); text-align: left; border-bottom: 1px solid var(--border); }
```

## Other surfaces

- **Navigation/sidebar:** preserve page hierarchy, sidebar width and resize handle. Apply page/section/item roles to labels. Keep active and focus states visible, including selected agent context. Do not hide actions on hover only.
- **Chat and tool notices:** chat prose uses the body role. Tool summaries and status notices use metadata size, readable secondary text and a consistent 16px icon, with an explicit disclosure affordance and outcome word. Tool output, commands, code and logs keep monospace and their own formatting. Avoid oversized cards for short notices; keep errors and retry actions visible.
- **Composer:** retain current full textarea size and Send/Stop controls. In chat, Stop uses a square icon with an accessible name and a tooltip explaining that it sends Escape to interrupt the agent or dismiss its prompt; terminal mode retains the Esc label. This is the explicit exception to labeled primary actions. Dialog dismissal actions remain Cancel. Align button, helper, keyboard hint and counter typography to roles. Never reduce the composer as a side effect of shared button rules.
- **Tasks, board, workflows:** use the same item title, metadata and status roles. Keep status words/icons and task actions. Use semantic success/warning/error tokens in both themes, including workflow timelines.
- **Agent UI:** style Coral's surrounding tabs, labels, request controls, help text, status and dialog. Agent-published iframe content is separate and sandboxed; do not impose workspace CSS inside it. Preserve expand/collapse and published interaction semantics.
- **Forms/settings/dialogs:** follow [Dialogs and settings panels](#dialogs-and-settings-panels) (one fixed size, one type scale, one row pattern, footer order). Keep form labels programmatically associated, native checkbox/select behavior, and focus trapping/return for dialogs.

## Dialogs and settings panels

Written from the designs the operator approved: New agent and Restart Session, New team and Edit member, the Goals layout, and Settings. They are **target conventions**: a dialog that has not been rebuilt yet follows its own rules until its task lands, and a new or reworked dialog follows these. The mockups and audits are in the review artifacts of the tasks that approved them (#7374 New agent and team, #7401 Goals, Settings). Where this section and an earlier line of this guide differ for a dialog, this section wins.

### Size and stability

- A dialog has **one fixed size** on desktop: 960 x 640 for a short flow (New agent) and 960 x 720 for a long one (New team, Edit member, Settings), never taller than the window minus 32px. It is the same size and in the same place on every step, every tab, and after every choice (a template, a provider, a mode, a theme). Only the body scrolls; the title, the tab or step strip, the recap and the footer stay put.
- **Reserve space for what may appear.** A note, warning or error that depends on a choice lives in a slot that already has its height (an invisible copy of the longest text keeps the slot sized), so choosing a provider does not move the Model control. A line that appears must not push the controls below it; if it cannot be reserved, it goes in a polite status line above the footer, not in the body.
- **Phone:** the dialog is a full-height sheet, the section list becomes a "Section" dropdown, the footer buttons are 44px high with Cancel at the left edge, and nothing scrolls sideways at 390px or at 200% text.
- A choice changes only what it names: a thinking level, a mode or a persona never changes the model; only a provider resets that agent's Model and Thinking. Text the person typed survives Next, Back and a tab change.

### Steps, tabs and the footer

- **Steps when order matters** (where, then who, then how; each step needs the one before). Use "Step 2 of 3: ..." in the header. **Tabs when the parts are optional tuning** (Agent, Permissions, Advanced; Workflow, Health check, Messaging). A final step may hold tabs. Do not use tabs for a sequence or steps for a set of settings.
- **Required fields are said in words** ("Required"), and are marked `aria-required`; a field with a default says nothing. Optional is said only where a person could think it is needed.
- A **disabled primary button says why**: the reason is visible next to the footer in a polite status line. Use the native `disabled` when that visible line carries the reason (a disabled button cannot take focus, so nothing else is lost); use `aria-disabled="true"` plus `aria-describedby` to the line when the button must stay focusable. The reason is never only in a tooltip, and never only opacity.
- **Footer order:** Cancel all the way at the left; Back, Next or the primary action together at the right, the primary last. A **recap line** above the footer says what will happen ("payments-sprint: 5 members, /tmp/app"). The primary says what it does ("Launch team", "Save settings"), and only the last step launches.
- Hold edits until Save (Edit member, Settings); Cancel throws them away and the list behind changes only on Save.
- **A settings panel has the same footer as a dialog, pinned to the bottom of the panel** (Team settings): one persistent bar with the status line ("You have unsaved changes." or "No changes to save."), Cancel at the left and Save at the right. Save is prominent, never scrolled out of sight or hidden, and is off, with its reason in the status line, until something changes; only the body above the bar scrolls.

### Type scale and rows

One scale for every dialog and settings panel, in `--font-sans` only (Plus Jakarta Sans): no monospace and no other family except for real code, paths in a terminal, and raw output.

| Role | Size / weight | Use |
| --- | --- | --- |
| Dialog title | 16px / 700 | The header. |
| Pane title | 17px / 700 | The title of the open tab or step. |
| Section heading | 14px / 600 | A group of rows inside a pane, under a 1px divider. |
| Nav tab | 14px / 400, selected 14px / 600 | The section list. |
| Row label | 13px / 500 | A setting's name; `--text-primary`, or `--text-secondary` above a field. |
| Control value, button | 13px / 400 value, 13px / 500 button | Inputs, selects, buttons. |
| Hint | 12px / 400 `--text-secondary` | One line under a label. |
| Badge | 11px / 600 | A short tag ("Gets the first task"); never the only carrier of meaning. |
| Reading text | 14px / 400, at most 70 characters wide | The long text in a detail pane (a goal's outcome). |

- **One row pattern:** the label with its hint under it on the left, the control on the right in a fixed 340px column. A long control (cards, a 2 x 2 set of boxes, a sentence of days and actions) takes its own full-width line under the label, on one line, never broken into pieces. Group rows under section headings with the same spacing everywhere.
- **No (i) tooltips.** The explanation is a visible hint: **one short line, about 10 words, 12px**. Anything longer goes behind a "Learn more" link or a disclosure, never a second line. A hint is written only where the label alone does not say what the setting does or what happens; a hint that restates its label is dropped, and rows that share one idea share one hint on their section. Data lines ("0 B of 20 GiB used") are not hints. A "Learn more" link is named after its setting (`aria-label="Learn more about <setting>"`), carries `aria-expanded` and `aria-controls` for the text it opens, and is a 44px target on touch. A tooltip may repeat a hint but never holds the only copy. The first view of a settings tab stays near 120 words; the word budget is tested.
- **Switches** are the product's switch (the label beside it, a hint under it), `role="switch"` or a labelled checkbox, never a button that says On or Off.

### Controls

- **Few options, segmented control or cards** (Provider, Thinking, Mode, Terminal backend); **many options, a dropdown** (Model, Machine, Theme). Cards carry a title and one line; the selected card has the accent border and `aria-checked`.
- **No detached "Change" buttons:** the control is the value. A path field is the path with Browse beside it, not a read-only value with a Change button.
- **One place to edit a thing.** A list row is read-only (its name and one summary line) and opens an edit dialog; the same fields are not also editable inline. A change made in the dialog shows in the row only after Save.
- A **bulk shortcut over a list** ("Set all workers to: [provider]") names who it covers and who it leaves alone, says what it sets (the provider only; each member's model and thinking go back to their defaults), and the rows show the result.
- A preset fills fields and leaves them editable ("Filled from the persona. Change it if you want a different name").
- Dangerous choices (Bypass permissions) are said in words and in the warning colour, not only a colour.

### Less text, progressive disclosure

- Every line earns its place. A dialog's words are counted and tested with a budget per step; cut a sentence before adding a disclosure. A step says what the next step is in about ten words ("Next: the persona, then model and permissions. All have defaults.").
- The common path is visible; rare or risky options sit in a **closed disclosure** ("Reviews and automatic rules", "Advanced", "Tool permissions") with a plain name and, where it matters, a count ("7 allowed, 0 denied").
- Prefer defaults over questions. A field with a good default is not required and not first.

### Keyboard and screen reader

- A dialog is `role="dialog"` with `aria-modal="true"`, named by its title, with a description where its primary action has consequences. Focus moves into it, is trapped, and **Escape closes it and returns focus to the control that opened it** (the page-wide `dialog_focus.js` does this; give it a real opener).
- Tabs are a `tablist`: one tab stop (the selected tab has `tabindex="0"`, the others `-1`), Up/Down or Left/Right/Home/End move and select, `aria-selected`, and each tab and panel name each other (`aria-controls`, `aria-labelledby`). On a phone the same sections are a labelled select.
- Segmented controls and card sets are a `radiogroup` of `role="radio"` with `aria-checked` and arrow-key movement; switches and checkboxes keep native behaviour.
- A rebuilt control keeps its focus (re-rendering a segmented control after a click must not drop focus). Conditional notes and errors are polite status regions, said once; an error also marks its field `aria-invalid` and is tied with `aria-describedby`.
- Targets are 44px high on touch; focus rings follow the global `:focus-visible` rule and are not clipped by the scrolling body. **Arrival ring:** when a dialog opens and a script puts focus inside it (a selected tab, the first field), a pointer start shows no ring round it and the first key press brings it; a key press just before it opens (Enter on Next, Enter on the button that opens it) shows it from the start, and so does no input at all (a script opened it), as the browser would (WCAG 2.4.7: the ring is hidden only for a pointer start). The module is `quiet_focus.js` and the rule `[data-quiet-focus] :focus-visible`; ring audits lift the quiet start before they measure.

### How to test a dialog

- **Stability:** measure the dialog's rectangle (`getBoundingClientRect`: left, top, width, height) after opening, after every step and tab, after each choice, and with each reserved note shown; all must be equal. Measure a control's top before and after the choice that could move it.
- **Font census:** read the computed family, size and weight of every visible text in the dialog (skip icon-font spans); each must be Plus Jakarta Sans and one pair from the table above. A stray size, weight or family fails the test.
- **Sizes and themes:** run at 1280 and 1024 wide, at 390 on a touch phone, and at 390 with the root font at 200%; dark and light. No sideways scroll; phone buttons, selects and inputs are at least 44px; Cancel is the leftmost control and the primary the rightmost.
- **Look at it:** open each screenshot before it is posted; goldens are regenerated only after reading the diff.

## Do / don't

| Do | Don't |
| --- | --- |
| Reuse `--accent`, `--text-secondary`, and existing spacing tokens. | Paste a literal blue, gray, or new 7px/9px one-off value into a component. |
| Use text tabs for Files sources and retain source navigation in preview. | Reintroduce four outlined source pills or hide tabs when a preview opens. |
| Keep artifact fields in six labeled table columns. | Join MIME, size, task, and date into one metadata sentence. |
| Keep Preview and Download/Open as explicit accessible actions. | Rely on hover-only glyphs or a clickable row with no action name. |
| Preserve code/terminal font settings and HTML preview isolation. | Apply workspace font/reset to xterm or relax iframe sandbox for a visual change. |
| Give a dialog one fixed size and reserve space for conditional notes. | Let a tab, a choice or a warning resize or move the dialog. |
| Say what is required and why a primary button is off, in words. | Disable a primary with no visible reason, or mark required fields with a colour only. |
| Put a setting's hint under its label; use the one row pattern. | Hide explanations in (i) tooltips, or lay rows out three different ways. |
| Make list rows read-only and edit in one dialog. | Offer the same field inline and in a dialog, or a detached Change button. |

## Review checklist for UI PRs

- [ ] Existing workspace layout, sidebar resize, composer, controls and preview flow remain intact.
- [ ] Type, icon, spacing, radius and color roles follow this guide; any exception has a concrete reason.
- [ ] Dark, light and at least one custom accent remain readable; body text reaches 4.5:1 and nontext control boundaries/status cues reach 3:1 where applicable.
- [ ] Keyboard focus, selected state, hover, disabled, loading and error are distinguishable; icon-only controls have accessible names.
- [ ] At 390px width, 200% zoom and coarse pointer, labels/actions remain available, tables and tabs are navigable, and targets are at least 44px high where touched.
- [ ] Reduced motion, long names, empty/busy/error states, and locale-dependent date lengths were checked.
- [ ] Files has four text tabs and retained inline preview; artifact tables keep six labeled columns and explicit actions.
- [ ] Code, terminal, rich preview and agent-published iframe behavior remain isolated from workspace styling.
- [ ] A dialog or settings panel keeps one size and place across every step, tab and choice (the rectangle is measured), reserves space for conditional notes, and scrolls only its body; on a phone it is a full-height sheet.
- [ ] Dialog text is Plus Jakarta Sans and on the dialog scale (a font census passes); rows use label and hint on the left and the control on the right; no (i) tooltip holds the only copy of an explanation.
- [ ] Steps are for order and tabs for optional tuning; required fields are said in words; a disabled primary says why; Cancel is leftmost and the primary rightmost; a recap sits above the footer.
- [ ] A thing is edited in one place (read-only rows, one edit dialog, no detached Change button); few options use a segmented control or cards and many use a dropdown.
- [ ] Dialog keyboard and screen-reader behaviour: aria-modal, Escape returns focus to the opener, tablist with one tab stop, radiogroups, polite status for notes and errors, 44px targets on touch.

## Reading a stack trace

The dashboard's JS is served with local variable and function names shortened (#7185), so the browser console's stack frames name short letters. Start Coral with `CORAL_NO_MINIFY=1` to serve the readable source in devtools, and say so in a bug report that carries a stack: name `CORAL_NO_MINIFY=1` as the way to read it.
