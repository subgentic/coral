# Chief checks API

All endpoints are local computer only. Signed person requests manage checks;
only the pinned receiving session (verified transport identity) or the person
may update a trigger. Hub requests are refused. These checks deliver text to
an existing agent: they never launch a new agent or run a connector themselves.

## Check definitions

- `GET /api/chief/checks` returns `{checks: []}`.
- `POST /api/chief/checks` creates a definition; `PUT /api/chief/checks/{id}`
  replaces it with its current `revision` (409 on concurrent edit).
- `GET /api/chief/checks/{id}` reads one definition.
- `DELETE /api/chief/checks/{id}` takes `{revision}` and disables/deletes it,
  preserving trigger history.

Fields: `name`, `instruction`, `target_board`, `target_session`, `notify_mode`,
`enabled`, `wake_if_asleep` (default false), optional `source_key`, and schedule.
`notify_mode` is `only_if_found`, `every_time`, or `daily_brief`.
Schedules use an IANA `timezone` and either `schedule_kind: interval` with
`every_minutes: 5|15|30|60`, or `schedule_kind: daily|weekdays` with `at: HH:mm`.
The target must still be an active board member. Credentials and sign-in links
are refused visibly; instructions are never silently redacted. Source keys
identify a UI source, and carry no connector configuration.

## Run and track

`POST /api/chief/checks/{id}/run` requires a fresh `Idempotency-Key` (8–128 plain
characters) per intentional action; retry the same action with the same key.
Returns 202 `{trigger}`. One unresolved trigger per definition coalesces fires.
Manual runs work while the schedule is disabled. Delivery failures and held
messages remain visible on the trigger; scheduler completion means delivery,
never that the agent checked its connector or resolved the trigger.

`GET /api/chief/triggers` returns `{triggers: [], summary_notice}`; optional
`check_id`, `before` (exclusive trigger ID), and `state` filter the newest 100.
Trigger delivery/reminder fields distinguish pending, held, delivered and failed;
error codes describe the failure without including instruction text in logs.
An unresolved open trigger receives at most one successful reminder, due after
15 minutes. Failed reminders are not repeatedly posted. Paused boards, sleeping
agents without consent, and disabled receive mode hold delivery. Wake consent
also uses the ordinary board hourly/live caps and normal wake permissions.

`POST /api/chief/triggers/{id}/state` takes `state`, optional `summary` (2 KiB),
and references: `routed` requires a same-board `task_id`; `waiting_on_operator`
requires `ask_id` attributed to the original receiving session; optional
`brief_id` must name that session's actual board message. Other states are
`open` and `done`. The CLI is:

    coral-agent check state ID --state done --summary 'Short result'

Summaries are cleaned/redacted agent words stored on this computer; they are
never inserted into subsequent instruction messages. Identity fields supplied
in a request do not authorize it. Reused role names cannot adopt old triggers
or references. A departed/archived target is never replaced automatically.

Limits: 100 definitions (including retained deleted ones), 10,000 triggers,
20,000 retained action keys; resolved history older than 30 days is pruned.
Unresolved triggers are retained. Board message dedupe uses a random per-trigger
key and kind, surviving delivery acknowledgement loss and process restarts.
