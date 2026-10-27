# UI style guide

Build new dashboard UI from the shared families below. Each family is one class (or a small set) declared once in `pkg/frontend/static/css/` (`components.css`, `layout.css`, `variables.css`), and a census in `tests/frontend/` fails when a page gives the same job a look of its own. A page's own class says only where a thing sits and how wide it is, never what it looks like. Run `npm --prefix tests/frontend run test:cloud` before you hand a change over: it runs every census listed here.

## Type and tokens

- **Type scale** (`variables.css`): `--fs-xs` 10, `--fs-sm` 11, `--fs-base` 12, `--fs-md` 13, `--fs-lg` 14, `--fs-xl` 16, `--fs-display` 32 (the welcome title only), with `--font-sans` and `--font-mono`. Write `var(--fs-*)`, never a number. Guard: `font_literal_census` (its list only shrinks).
- **Spacing and radius**: `--space-xs` to `--space-xl` (4 to 16 px), `--radius-sm` to `--radius-xl`. Control heights: `--control-height` 36, `--control-compact-height` 32, `--control-touch-height` 44 (touch screens). Guard: `css_color_census` (no bare colour or radius outside the tokens).

## Families

- **Button**: `.btn` with `.btn-primary`, `.btn-quiet`, `.btn-danger`, `.btn-small` or `.btn-icon` (icon only). 13/500, 36 px, 44 on touch. A selected toggle is the accent fill (`aria-pressed="true"`). A choice among two to five buttons is `.btn-seg`. Guard: `button_family_census`, `selected_style`.
- **Chip** (a small label, status or count): `.chip`, with `.chip-tag` and `.chip-count`. Set colour and margin only. Guard: `chip_census`.
- **Form row**: the `settings_view` row (label above, control, hint) or a hand-built `.form-row` with `.form-label`, `.form-control-*`, `.form-check` and `.settings-hint`. No `style` attribute on a field. Guard: `form_row_census`, `settings_view_census`.
- **Menu**: `.menu` with `.menu-item` rows (`.menu-item-danger` for the one destructive row), arrow keys from `menu_keys.js`. Guard: `menu_census`.
- **Notice** (a message about the page's state): `.notice` with a tone (`.notice-info`, `-ok`, `-warn`, `-error`), `.notice-bar` at a screen's edge, `.notice-float` over content, `.notice-line` for a load or error line. Guard: `notice_census`.
- **List row** (a row of a sidebar list): `.list-row`, `.list-row-current` for the current one. One line, 36 px (44 on touch). Guard: `list_row_census`.
- **Facts** (label and value pairs): a `dl` with `.facts`. Guard: `facts_census`.
- **Group head** (the heading of a group of rows or a section): `.group-head`, or `.group-head-lg` for a page's section title. Guard: `group_head_census`.
- **Pane** (header band, scrolling body, pinned footer): `.pane`, `.pane-head`, `.pane-body`, `.pane-foot`, `.pane-aside`. Guard: `pane_census`.
- **Toolbar** (a row of controls over a list): `.toolbar`, spacing from the `--toolbar-*` tokens. Guard: `toolbar_census`.
- **Tabs** (a text tab strip): `.tabs` holding `.tab` buttons (`aria-selected="true"` or `.active` is the underlined one) and `.tab-count`; `.tabs-icons` for a narrow panel's icon tabs. Guard: `tab_family_census` (its baseline is empty).
- **Card**: the tokens `--card-border`, `--card-radius` and `--card-pad`, `--card-pad-dense`, `--card-pad-roomy`. No card inside a card. Guard: `card_census`.
- **Table**: the shared data table (`data_table.js`, `dt-*` classes in `data_table.css`); no other stylesheet styles a table. Guard: `data_table_census`.
- **Dialog**: one of `.dlg-confirm` (28 rem), `.dlg-form` (40 rem) or `.dlg-flow` (60 rem, 640 high) beside `.modal-content`; its type comes from the `--dlg-*` tokens. Guard: `dialog_census`.
- **Empty state**: `.empty-state` with `-line`, `-hint`, `-action` (a line, an optional hint, an optional action, no box). Guard: `empty_state_census`.
- **Back link**: `.back-link`, "<- Name" naming where it goes. Guard: `back_link_census`.

## Rules every new screen follows

1. Look for the family first. If none fits, add a variant to the family and extend its census, rather than a new class with its own look.
2. Every control is reachable by keyboard and is 44 px on a touch screen; check the page at 390 px wide, at 200% text and in forced-colors mode.
3. Put text in the page as a line the user can read (`.notice-line`, a status line), not only in a toast.
4. Never write an inline `style` for a look, a literal font size, a bare colour or an inline event handler (`data-on-*` attributes instead).
