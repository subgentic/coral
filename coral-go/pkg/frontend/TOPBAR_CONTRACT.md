# The dashboard's top bar: what Hub pages may copy (#11106)

Coral Hub draws its own pages' bar so that it matches the dashboard's. This is the contract: these names and values are kept stable across releases; a change to one is a change to this file, in the same commit, and
`tests/frontend/topbar_contract.test.mjs` fails until both agree. The bar's tabs are the dashboard's (Agents, Inbox, Servers, Docs); this contract adds none.

## Tokens (`static/css/variables.css`)

| Token | Dark (default) | Light |
|---|---|---|
| `--topbar-bg` | `rgba(17, 17, 20, 0.92)` | `rgba(236, 237, 240, 0.92)` |
| `--topbar-border` | `rgba(46, 46, 54, 0.6)` | `rgba(201, 205, 211, 0.8)` |

The other tokens the bar and its tabs read, named in the same file: `--text-primary`, `--text-secondary`, `--accent`, `--border`, `--bg-hover`, `--fs-md`, `--fw-medium`, `--fw-strong`, `--radius-sm`.

## The bar (`static/css/layout.css`, `.top-bar`)

- A flex row, items centred, space between; padding `7px 20px 7px 12px`.
- Background `var(--topbar-bg)`, a 1 px bottom border `var(--topbar-border)`; above it a border-top of the same colour as tall as the device's top safe-area inset (`env(safe-area-inset-top, 0px)`), so the bar's colour fills a notch's band.
- `position: relative; z-index: 20; flex-shrink: 0`.

## The tabs (`static/css/components.css`, `.tab`)

- `min-height: 40px` (the touch height, `--control-touch-height`, 44 px, on a phone or a coarse pointer); inline padding `0 12px`; no background, no border but a 2 px bottom border that is transparent at rest.
- Colour `var(--text-secondary)`, font size `var(--fs-md)`, weight `var(--fw-medium)`; hover colour `var(--text-primary)`.
- The active tab (`aria-selected="true"`, `.is-current` or `.active`): colour `var(--text-primary)`, weight `var(--fw-strong)`, the bottom border `var(--accent)`.
- Keyboard focus: a 2 px `var(--accent)` outline, offset -2 px.
- The row (`.tabs`): flex, `gap: 4px`, a 1 px bottom border `var(--border)`, scrolls sideways without a scrollbar.

## The account menu

Drawn by the dashboard from `GET /api/account` `nav`, by key, from the dashboard's own table (`static/account_info.js`): account, billing, team, team-links, usage, goals, machines, saved. Servers is first, Sign out last.

<!-- contract: the lines below are checked against the stylesheets by topbar_contract.test.mjs: file | text that must be in it -->
<!-- contract: css/variables.css | --topbar-bg: rgba(17, 17, 20, 0.92); -->
<!-- contract: css/variables.css | --topbar-border: rgba(46, 46, 54, 0.6); -->
<!-- contract: css/variables.css | --topbar-bg: rgba(236, 237, 240, 0.92); -->
<!-- contract: css/variables.css | --topbar-border: rgba(201, 205, 211, 0.8); -->
<!-- contract: css/layout.css | padding: 7px 20px 7px 12px; -->
<!-- contract: css/layout.css | background: var(--topbar-bg); -->
<!-- contract: css/layout.css | border-bottom: 1px solid var(--topbar-border); -->
<!-- contract: css/layout.css | border-top: env(safe-area-inset-top, 0px) solid var(--topbar-bg); -->
<!-- contract: css/layout.css | z-index: 20; -->
<!-- contract: css/components.css | min-height: 40px; padding: 0 12px; -->
<!-- contract: css/components.css | border-bottom: 2px solid transparent; -->
<!-- contract: css/components.css | font-size: var(--fs-md); font-weight: var(--fw-medium); -->
<!-- contract: css/components.css | .tab[aria-selected="true"], .tab.is-current, .tab.active { color: var(--text-primary); font-weight: var(--fw-strong); border-bottom-color: var(--accent); } -->
<!-- contract: css/components.css | .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); -->
<!-- contract: css/variables.css | --control-touch-height: 44px; -->
