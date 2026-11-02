# Hooks for tools that drive Coral's page

For Coral Hub's scripts and any other tool that opens Coral's dashboard in a browser and waits for it or clicks in it. These are **supported**: they are kept, a change to one is a line in the release notes ("For Coral Hub"), and tests pin them (`tests/frontend/ready_signals_browser.test.js`, `tests/frontend/hub_hooks.test.mjs`).

## `window.__coralReady`: when the page is ready

`window.__coralReady` is a Promise that resolves once, after **five required parts** are done. `window.__coralReady.parts` is a snapshot object of every part (`true` once done, and it never goes back to `false`). It includes the two optional parts below, which stay `false` on a page that has no Inbox list or Hub frame: check the five required parts by name, never "every value is true".

| Part | Done when |
|---|---|
| `liveList` | the agent list has been drawn for the first time |
| `liveListLoaded` | the page start's HTTP list answers have been applied (or failed) |
| `feed` | the live feed (`/ws/coral`) connected |
| `history` | the first chat-history list was loaded (or failed); a popout counts it as done |
| `settings` | the settings were loaded (or failed) |

Two **optional** parts are in `parts` too, but the main promise never waits for them (a Coral with no Inbox page, or no Hub frame, would never resolve):

| Part | Done when |
|---|---|
| `inboxListDrawn` | the Inbox's first folder list (the native Inbox) is drawn |
| `hubFrameLoaded` | the Hub's own framed Inbox page (`iframe.inbox-frame`) fired its `load` event |

`window.__coralReady.startup(...names)` resolves when just those parts are done (`startup()` with no names waits for the five required ones; an unknown name rejects). `window.__coralReady.liveListRendered()` resolves with the row count of the next agent-list draw, and `window.__coralReady.agentSelected(id)` when an agent's view has settled. Window events: `coral:ready`, `coral:live-list-rendered`, `coral:agent-view-ready`.

### Guarantees

1. **Handlers before the list.** The page's delegated event handlers (every `data-on-click` and the other actions) are bound before `liveListLoaded` is marked, so a control clicked in the turn that part resolves works. Wait for `liveListLoaded` before injecting state or clicking.
2. The main promise resolves once, after all five required parts.
3. A part never goes back to `false`, and a part name is never reused for another milestone.

## `data-coral-hook`: stable names for elements

An element a tool should find carries `data-coral-hook="<name>"`. Use it instead of a class or an id, which are for styling and may be renamed. The current hooks (also in `tests/frontend/hub_hooks.json`, which the Hub's own list was checked in as):

`nav-tab-<hub-inbox|agents|history|automations|tokens|servers|docs|artifacts|board>` (the top tabs), `top-nav-tabs`, `top-bar`, `sidebar`, `inbox-nav-list`, `agentic-state`, `live-view-switch`, `phone-nav-slot` (with `data-phone-nav` naming the slot), `phone-menu-button`, `account-button`, `account-menu`, `inbox-frame`, `send-button`, `sidebar-kebab-button`, `sidebar-kebab-menu`, `agent-ui-card`, `agent-ui-expand`, `agent-ui-dismiss`, `view-list-item`, `view-list-trigger`.

Also relied on, and kept: `body[data-nav-tab]` (the open top tab), `[data-view-list]` (a folder list's name), the `coral-last-place` local storage key, and the words of the Inbox folders, the account menu and the phone bar that the Hub's list names.
