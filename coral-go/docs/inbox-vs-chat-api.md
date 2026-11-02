# The Inbox-versus-chat counts API (for coral-hub)

`GET /api/analytics/inbox-vs-chat` answers how much of what the Operator did on **one computer** they did in the Inbox and how much in a chat or terminal. **Counts only**: day buckets, kinds, team ids and numbers. No text, no length and no id of anything is in the answer. A Hub that shows one owner's whole picture adds up the answers of that owner's computers (see "Merging").

## Who may read it

- At the computer: the person.
- Through Coral Hub: **the Hub owner of a personal computer only**. It is an owner route of the tunnel table (tier View, owner-only, read only). A guest, a grantee, a viewer, another account's owner marker and a forged stamp get `403 owner_only`.
- **A computer enrolled to a Hub team is refused through the Hub, even for its owners and admins: `403 not_for_teams`** (fail closed). The reason: on a team's computer each owner may read only their own rows, and the Operator touches (the chat side) carry no actor, so one owner's counts cannot be told from another's. It is shown there only to the person at the computer. (If the touches ever carry an actor, this changes and this note says so.)

## Request

`GET /api/analytics/inbox-vs-chat?days=&team=`

| parameter | meaning |
|---|---|
| `days` | the window in UTC days ending with today; default 28; **more than 90 is cut to 90** (the touches are kept 90 days); `0`, a negative number or a non-number is `400` |
| `team` | one team's bare board name (letters, digits, `_`, `.`, `-`; at most 64); another value is `400`; none means every team |

## Answer (`200`)

```json
{ "days_asked": 28, "generated_at": "2026-11-02T09:00:00Z",
  "counts": {
    "days":    [ { "day": "2026-11-02", "inbox": 12, "chat": 9, "unknown": 1 } ],
    "inbox":   { "approve": 40, "comment": 22, "answer_prompt": 6 },
    "chat":    { "typed": 120, "answer_prompt": 31 },
    "unknown": { "answer_prompt": 5 },
    "apart":   { "wake": 4, "stop": 1 },
    "teams":   [ { "team": "coral-go-team", "inbox": 60, "chat": 140 } ],
    "phone":   { "phone": 12, "other": 30 },
    "record_since": "2026-11-02",
    "note": "These counts come from a record that detects edits made outside Coral but cannot prevent them: it is a record for you, not an audit. Edits made outside Coral are shown unless the whole record was rewritten." } }
```

- `days`: only the UTC days that have any count, oldest first (a missing day is zero on every side). `inbox`, `chat`: actions on each side that day; `unknown`: answers whose side is not known.
- `inbox`, `chat`, `unknown`, `apart`: counts by **kind** over the whole window. Kinds: for the Activity record `approve`, `changes`, `deny`, `ignore`, `unignore`, `save`, `unsave`, `answer` (a question's button), `goal_close`, `proposal`, `dismiss`, `mark_read` (the actions it records, `undone` left out); `comment` (the Operator's own comments on files and goals); from the touches `typed` and `answer_prompt` (an answer to a question, plan or permission); under `apart`, `wake`, `restart`, `stop`, `approve` (a task's approval).
- `teams`: team ids (bare board names) with their counts by side, busiest first. `phone`: the Inbox's Activity-record actions the page said were taken from a phone, and the rest.
- `record_since`: the UTC day of the oldest row of the Activity record, or `""` for none. **Before it the Inbox's side cannot be told apart**, so a share must start there.
- `note`: the sentence a page must show with the counts: the record detects edits made outside Coral and cannot prevent them; it is not an audit.

## What counts on which side

- **Inbox:** an Activity-record action unless the page said it was taken in a chat (`surface` of `chat`); an answer to a prompt the page said was given in the Inbox (`surface` of `inbox`); the Operator's comments.
- **Chat:** typing to an agent (one per burst of 30 seconds: always chat, the Inbox cannot type to an agent); an Activity-record action the page said was taken in a chat; an answer to a prompt the page said was given in a chat.
- **Unknown:** an answer to a prompt with no word from the page about where. It is **left out of the share, not guessed**.
- **Apart:** waking, restarting, stopping an agent and approving a task. The Inbox cannot do them, so they are not in the share.
- `surface` is what the page said, one of `inbox`, `chat` or nothing, taken from a header the page adds to a write it makes right after a real click or key in the Inbox or in an agent's chat or terminal. It is shown as "reported by the page".

## The share

`share = inbox / (inbox + chat)` over the same days; a day with neither side has no share (a gap, not a zero). The Operator reads it as a 7-day rolling share starting at `record_since`.

## Merging several computers

Add the counts of each computer, day by day and kind by kind; take the earliest `record_since` among the computers that have one, and start a merged share only from the **latest** `record_since` (before it some computer's Inbox side is not counted). Team ids are per computer. A computer that refuses (`not_for_teams`) contributes nothing: say so rather than show a smaller total as the whole.

## Errors

| status | `code` | when |
|---|---|---|
| 400 | | `days` or `team` is invalid |
| 403 | `owner_only` | a Hub request that is not the owner's, and an agent token or a script that is not a person at this computer |
| 403 | `not_for_teams` | through the Hub, on a computer enrolled to a Hub team |
| 500 | | the counts could not be read |
