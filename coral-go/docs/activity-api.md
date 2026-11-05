# The Activity record's API (for coral-hub)

`GET /api/activity` answers what the Operator did in Needs you on **one computer**: approve, ask for changes, deny, ignore, save and their undos, answers to questions, a goal closed. A Hub that shows one owner's whole Activity merges the answers of that owner's computers (see "Merging").

It is a **record for the Operator, not a tamper-proof audit trail**: a program that runs as the Operator's user can edit the database file. The record is chained so that most edits show (see "The check"), and that is all it promises.

## Who may read it

- At the computer: the person (the dashboard or the signed command line).
- Through Coral Hub: **the Hub owner only**, the account the computer is linked to. It is an owner route in the tunnel table (tier View, owner-only, query parameters below). A guest, a grantee, a viewer, another account's marker and a forged stamp are refused `403 owner_only`.
- Read only. The route is a GET; nothing in the record can be written or removed through the Hub.
- **Whose rows you get** (the Operator's choice, 2026-11-02, "own rows only"):
  - A **personal** computer has one owner: they read every row, **including the rows whose `actor` is `local`** (the person at the computer is that same one person, so those are the owner's own rows).
  - A computer **enrolled to a Coral Hub team** reads nothing through the Hub unless the stamp carries the owner's **stable id**: the owner check needs exactly one valid `hub-uid-` id, one label, the recorded organisation and an `owner` or `admin` role. A request with no valid id (a label alone, or an id that is not `hub-uid-` and 32 hex digits) is refused `403 owner_only` and is **never keyed on the label**: it fails closed. The Hub must therefore send `X-Coral-Hub-User-Id` for team computers (a Hub that does not yet send it reads nothing there).
  - On such a team computer: the owners are the recorded organisation's `owner` and `admin` roles (a `member`, even one granted the computer, and another organisation's people are refused). Each owner's Hub request returns **only the rows whose `actor` is theirs**, by their stable id. The computer filters; another owner's row is never sent to the Hub, and neither is its count: `check.rows` is the requester's own count and `check.first_bad` is left out. The check's `intact` and `reason` are still the whole record's.
  - The person at the computer itself (no Hub in the request) reads every row, including every owner's.
- An agent token has no route to it.

## Request

`GET /api/activity?team=&action=&before=&before_at=&limit=`

| parameter | meaning |
|---|---|
| `team` | one team's bare board name (letters, digits, `_`, `.`, `-`; at most 64); another value is `400` |
| `action` | one of `approve`, `changes`, `deny`, `ignore`, `supersede`, `unignore`, `save`, `unsave`, `undone`, `answer`, `dismiss`, `goal_close`, `proposal`, `mark_read`, `goal_review`, `send_review`, `unsend_review`, `hub_update_check`, `hub_update_relaunch`, `message`, `task_create`, `task_complete`, `task_cancel`, `task_publish`, `task_edit`, `task_remind`, `task_park`, `task_reply`, `prompt_answer`, `prompt_allow`, `prompt_reject` (a permission prompt answered Yes or No: the note is the option's own label, the title is empty), `wait_dismiss`, `wait_send` (#13609), and from slice 2 `mark_unread`, `file_tags`, `file_star`, `file_unstar`, `file_keep`, `file_release`, `file_delete`, `file_share`, `saved_add`, `saved_update`, `saved_remove`, `chat_flag`, `chat_send`, `run_seen`, `agents_record`, `goal_create`, `goal_edit`, `goal_driver`, `goal_move`, `goal_request_accept`, `goal_request_decline`, `inbox_hide`; another value is `400` |
| `before`, `before_at` | the cursor: rows older than the pair (`before_at`, `before`), both taken from the previous answer's `next_before` and `next_before_at`. `before_at` alone is `400`; `before` alone pages by id (the id grows with time on one computer) |
| `limit` | rows per page; default 50, **at most 200** (more is cut to 200); `0`, a negative number or a non-number is `400` |

## Answer (`200`)

```json
{
  "actions": [ { "id": 41, "at": "2026-11-02T05:41:12.304Z", "actor": "local", "action": "approve",
                 "item_kind": "file", "item_id": "<64 hex>", "version": "<64 hex>", "team": "coral-go-team",
                 "source": "local", "hint": "phone", "title": "plan.md", "note": "" } ],
  "more": true,
  "record_id": "<32 hex>",
  "limit_max": 200,
  "next_before": 41,
  "next_before_at": "2026-11-02T05:41:12.304Z",
  "check": { "rows": 1284, "intact": true, "note": "Edits made outside Coral are shown unless the whole record was rewritten." }
}
```

- `actions`: newest first, ordered by (`at`, `id`) descending.
  - `id`: unique **within this computer's record**, growing with time. Pair it with `record_id`; it is not unique across computers.
  - `at`: UTC with milliseconds, fixed width (`YYYY-MM-DDTHH:MM:SS.mmmZ`), so it sorts as text.
  - `actor` is one of:
    - `local`: the person at the computer itself.
    - `hub:hub-uid-<32 hex>`: a Hub owner on a **team's** computer, by the **stable user id** the connector stamps in `X-Coral-Hub-User-Id` (`hub-uid-` and 32 lower-case hex digits), byte for byte: `actor == "hub:" + hubUserId`.
    - `hub:<12 hex>`: a Hub owner on a **personal** computer, by a hash of the label: **`"hub:"` + the first 12 lower-case hexadecimal digits (6 bytes) of the SHA-256 of the bytes of the label the connector stamps in `X-Coral-Hub-User`, exactly as sent** (UTF-8, no trimming, no case folding, no normalization, no salt). The label is the account's `hub-user-` and 8 hex digits, so the value is as stable as the label is: it changes only if the Hub changes an account's label. The Hub computes the same value for its owner by hashing the label it stamps. Vectors:

      | label | actor |
      |---|---|
      | `hub-user-1234abcd` | `hub:90328ec01809` |
      | `hub-user-9999ffff` | `hub:1802bdf6841b` |
      | `hub-user-0000aaaa` | `hub:0c74ded601b3` |
      | `Hub-User-1234ABCD` | `hub:e7c28f167ef5` |

      (the last shows that nothing is folded). A Go test (`TestAPersonalComputersHubActorLabelMatchesTheVectorsInTheAPINote`) holds these same values and fails if this note and the code disagree.
    - `hub:unknown`: a request that was not an authentic owner's. No owner ever reads it.
    - Never an email or a name.
  - `action`: as in the table above.
  - `item_kind`: `file`, `question`, `goal`, `proposal`, `message`, `task` (a task, #13609), `chat`, `workflow_run` or `job_run` (a failed run's `run_seen`: a workflow run's `item_id` is the run's number; a `job_run`'s is `jobID:runID`, two numbers and a colon, with the job's name as the title (#13626); an older `job_run`-less row of kind `run` has the run's number alone and cannot be linked), `setting`, `goal_request` or `agent` (an agent's session name, #13609). `item_id`: the item's id (a file's digest, a goal's or proposal's number, a question's message number). `version`: for a file, the digest of the exact version acted on (the same as `item_id` today; a file is addressed by its digest), else absent. The item is named by id and kind plus `title`, a **short label** (at most 120 characters): words an agent wrote, so show it as text and never build a link from it.
  - `team`: the board's bare name on that computer.
  - `source`: `local` or `hub`, decided by the computer from the request's own provenance. `hint`: `phone`, or absent; it is only what the page said about itself, so show it as "reported by the page". `surface`: `inbox`, `chat` or absent, the part of the page the action was taken in, as the page said (a closed list of two words; anything else is stored as nothing, and it is part of the row's chain hash); show it as "reported by the page" too.
  - `note`: the Operator's own one-line reason or chosen option, redacted for secrets and cut to 200 characters; absent when none (or when the redactor refused). **No comment body, file content, answer text, picture or secret is ever in a row.**
- `more`: whether rows exist past this page. `next_before` and `next_before_at` are the last row's pair (absent on an empty page).
- `record_id`: this computer's record's own random id, made once with the table and never derived from another id. Rows from different computers are told apart by it.
- `limit_max`: the largest `limit` the computer honours.
- `check`: **on the first page only** (no `before`): see below.

## Errors

| status | `code` | when |
|---|---|---|
| 400 | | a parameter above is invalid |
| 403 | `owner_only` | a Hub request that is not the owner's (and an agent token or a script that is not a person at this computer) |
| 500 | | the record could not be read or checked |

## The check

Each row stores a SHA-256 of the row before it and of its own fields, and a head remembers the newest and the oldest kept row. The computer re-checks the whole chain when the first page is read and answers `check`:

- `intact: true` and `rows`: the count; or `intact: false` with `reason`, **a closed list of three codes and nothing else**: `edited` (a row's fields no longer match its hash), `removed` (a row is missing in the middle, or the oldest rows were cut off) or `cut_off` (rows are missing from the end). A `reason` never carries a row number, an actor or a count of other people's rows. `first_bad` (the id of the first row that does not match) is present for the person at the computer and a personal computer's owner, and is left out for a team owner. **`rows` counts only the requester's own rows** for a team owner (the whole record for those who may read all of it).
- `note` is always the sentence above. **The chain has no secret**: a program that can write the database can re-hash every row and the head and leave no break. The check catches a partial, careless or one-row edit, not that.

**Only the computer can verify.** Rows carry no hash on the wire, so a Hub cannot recompute the chain and should not try: show the computer's own `check` (and `note`) beside that computer's rows, say "The record was changed outside Coral" when `intact` is false, and never present an intact check as proof against a determined edit.

## Merging several computers

Keep each computer's `record_id`. Order the merged list by (`at`, then `record_id`, then `id`) descending; page each computer with its own `next_before` and `next_before_at`, and ask it for more only while its `more` is true. A computer's check applies to that computer's rows only. Times are as accurate as each computer's clock.

## Retention

A year or 50,000 rows per computer, whichever is less, trimmed once a day, oldest first; each trim logs a count (no content). Nothing else removes a row. A deleted team's rows stay.
