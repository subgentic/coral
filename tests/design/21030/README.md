# Coral Live controls — task #21030

Build against local-route contract #21047 and the approved v2 mock (#21015):
coral://artifacts/aee5fc29f019a4375968925943af483e871e492d9b1623d9d2216cef5a835fb2

The local Team settings entry appears only after GET `/api/live/links` succeeds.
Cloud and remote team callers are refused. The backend gate stays shut.
The component creates a draft using the copied Hub UUID, edits expiry/delay and
one agent's chat pick, loads the checked public frame, and requires the current
preview plus a checked acknowledgement before Go live, Resume or Re-confirm.
Pause and Stop are explicit local actions. Stop invalidates pending UI results.

Draft values edit the next public view. Approved live values describe what is
currently public, including after reload. A new agent requires another go-live.
The persistent Needs-you card reads the approved live snapshot and refreshes
through the list route, whose backend applies the deadline clock. No enabling
request is issued by a notification, refresh or timer. Public posts and chat are
rendered as text, with fixed withheld markers and no Markdown or automatic links.

## Comparison

The review’s `comparison.html` artifact is a self-contained side-by-side of the unchanged approved
mock and isolated built controls at 390/1440 px in dark/light themes.

Contract amendments authorized by the Orchestrator:

- Share through lists only this computer’s active Hub links and sends the selected `via`. A separate box takes the copied Hub UUID; the computer never receives a public URL.
  The link line says “The link is on the Hub page”.
- No viewer count. Last-viewed age is shown only when valid and reported by Hub.
- One chat checkbox per agent; selecting another replaces the previous pick.
- Editable draft values remain distinct from the approved live display.

The component uses shared card padding, borders and radius, shared warning
notices, and native theme tokens. These differ from the standalone mock's
hand-written card/notice styling. The title sizes remain the approved 24/22 px,
expressed as scoped rem tokens. Dates, roles, roster size and messages in the
screenshots are fixture data. Public message times use local date/time. The
service-holding sentence says “Coral’s service” instead of “our servers”.
The built screenshots isolate the component and do not show application chrome.

## Scope of proof

The browser suite runs on an isolated Coral server and mocks all `/api/live/*`
responses. It proves the local UI contract, stable-key chat choice, single chat
selection, preview/read/hash gates, 409 invalidation, inert text/withheld markers,
Pause/Resume/Re-confirm, approved-versus-draft reload behavior, persistent Inbox
card, missed re-confirm state, and Stop versus a late preview reply.

It does not prove a real Hub connection, server authorization, backend chat
availability, real-route deadline enforcement, or end-to-end Settings navigation.
Remote-team refusal is exercised before a fetch; cloud refusal is implemented
with the shared local-owner guard but is not a separate cloud-boot browser case.
Real-route integration follows #21047 landing, per the Orchestrator's instruction.
The release batch supplies the full browser gate. No terminal view is included.

Validation logs and exact results accompany the review submission. The initial
baseline browser run failed because `live_controller.js` did not exist. An
intermediate final run caught a timestamp-fixture scope error; it was corrected.
Static checks caught native styling/import policy violations; these were fixed
rather than adding visual or import exceptions. The only new census entries
register a shared-token card and the two deliberately local-only API reads.

The frontend Go package initially failed its embedded-tree size check: 8,046,335
bytes versus 8,030,208. Its documented standing tree-plus-64-KiB policy allows
8,112,128; the change applies that value with its reason in the commit message.
Startup JavaScript/CSS caps and their baselines are unchanged.

## Round-one validation

- Full `CORAL_START_BASE=815ce65f8f npm --prefix tests/frontend run test:cloud`: 452 checks, exit 0.
- `run_cdp_suites.mjs --only live_controls_browser --shards 1 --retries 0`: 1/1 passed, 1.8 seconds total.
- `go test ./pkg/frontend -count=1`: passed, 29.933 seconds.
- `start_bytes_delta.mjs 815ce65f8f`: app.js 405,549 → 405,549 gzipped bytes; start CSS 106,326 → 106,326.
- Four final screenshots opened: 390/1440 px, dark/light.

Validation ran on production source at cf3723ae4c; the final amendment adds this report only.

## Review correction (#21065)

The routes’ link timestamps are RFC3339 strings, unlike public-frame message times (epoch seconds). Controls and persistent cards now parse the link times with `Date.parse`. The updated browser fixture uses the actual string shape and fails on the prior revision specifically because the due notice stays at “Coral Live is on”. The fix also restores the active-Hub picker beside the copied-ID box, sends `via`, caches a list-route 404 for the page session, and restores the unrelated Inbox helper and Boolean conversion. Only the newly added Live hook key is shortened to preserve zero startup growth.

The Hub list is read from this computer’s existing `/api/cloud/links` route after the local-only mount guard. Paused/revoked/removing links are excluded. With two active Hubs the person must choose. An existing link after reload uses the disabled placeholder “Hub selected when created”: `liveLinkView` does not expose its saved `via`, so the UI does not guess a Hub name.

### Correction validation

- Full `test:cloud`: 452 checks, exit 0.
- Updated controller browser suite: 1/1 pass, 1.8 seconds total. Same suite on 658af6edba fails at the RFC3339 due-notice assertion.
- Frontend Go package: pass, 34.205 seconds.
- Startup delta against 815ce65f8f: JS 0 gz bytes; CSS 0 gz bytes.
- Four corrected screenshots opened (390/1440, dark/light).
- Production source validated at 578f26a004; final amendment adds this correction report only.

Updated comparison: coral://artifacts/0abbc3aff03f21ea2e64e6ca575f627e333b16a6dfa5f88737b129a1c17c1645
