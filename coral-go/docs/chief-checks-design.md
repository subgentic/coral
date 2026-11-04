# Chief checks: design for #13252 / Goal #220

A check schedules an instruction to an existing agent. Coral stores the instruction,
schedule and progress; the agent uses its own connectors. **Coral neither accepts
credentials nor queries mail, calendars or other connector services.** No credential
fields or raw connector configuration; redact/reject secrets before persisting
instructions/results, and never log their raw text. The approved
mockup is coral://artifacts/a6259d30f7a4b978dea503db4fecdeae35218a0f8e9bffa34d19694ca3ccba15.

**Reuse the scheduler.** One check owns one `scheduled_jobs` row with a new
`job_type=check`, plus check metadata: name, instruction, target board/session,
notify mode, optional source-inventory key, enabled, revision. Bound name/instruction/
summary to 120 characters/8 KiB/2 KiB; validate target membership and all enums. Existing prompt and
workflow jobs keep their behavior. Add a delivery callback to `JobScheduler` rather
than launching a prompt agent: check jobs need no repository, worktree or CLI flags.
Creation/edit updates the job and check together in the session database. Reuse
cron validation, timezone, run history, concurrency/failure pause, and Run now; the
latter works while disabled and does not move the normal schedule. Initial interval
presets are 5/15/30/60 minutes (the mockup), mapped to five-field cron; daily and
weekdays use HH:mm plus an explicitly validated IANA timezone. “Day” is daily at
the chosen morning-brief time. Show the next fire time and inherit the existing
scheduler's lookback/DST behavior; do not approximate arbitrary minute intervals.

**Deliver, then track the outcome.** A due/manual run creates a durable trigger and
outbox entry before delivery. Snapshot instruction, mode, check revision and exact
target session/board; default the target to the configured Chief when creating a
check, and never silently retarget a renamed/replaced agent. Use the normal board
message/notice delivery, addressed only to that verified member. Wake a sleeping
selected agent through the existing lifecycle path, preserving its permissions;
missing/archived targets become a visible delivery error, not a replacement launch.
The existing idle-wake callback covers auto-sleep only: explicit scheduled-check
consent must cover the sleeping case required here. Prompt/permission holds still
hold delivery; no direct terminal typing. A fixed system frame carries the trigger
id, resolution command and the user's instruction as quoted data; clean/defuse
embedded mentions, controls and marker text, keeping only the intended recipient live.

The session database and board database are separate. Add a board-side dedupe key
`(trigger_id, delivery_kind)` committed with its message, then acknowledge the outbox;
restart/retry must not duplicate the message. Deduplicate scheduler slots and Run now
requests too. A successful delivery completes the *scheduled run*, not the trigger.
Keep one unresolved trigger per check: later ticks coalesce and show “already open”;
Run now returns that trigger rather than multiplying notifications. An explicit
retarget/edit affects subsequent triggers, not one already delivered.

**Resolution and reminders.** A trigger starts `open`, records delivery/error and
message ids, timestamps and `reminded_at`, and stays unresolved until `done`.
`routed` requires a same-install task reference; `waiting_on_operator` requires an
existing ask reference. Both remain visible and owned by the receiving agent; their
linked task/ask supplies its normal reminder behavior. Only an unresolved `open`
trigger gets one reminder after 15 minutes, through the same durable delivery/wake
path; retries and restart cannot repeat it. The receiving session alone may report
progress/resolve; the Operator may inspect and resolve/reopen explicitly. Responses
are bounded summaries/references, never connector bodies or credentials. Repeated
resolution is idempotent; disabled/deleted checks stop new fires but preserve triggers.

**Notification policy.** `only_if_found` requests silence for “nothing new”;
`every_time` requests a result each run; `daily_brief` requests inclusion in Chief's
next brief. Carry the policy in the instruction and persist the agent's reported
outcome; use existing in-app board/ask delivery. For daily brief, retain an unconsumed
result until the agent references its actual brief message; show “awaiting brief,”
not “notified.” A waiting-on-Operator result links the real ask in Needs you. No
push, quiet-hours scheduling or webhooks in this slice, and no silent “all clear”
when the agent/connector is unavailable.

**API and Sources.** Operator/person-only `GET/POST /api/chief/checks`,
`GET/PUT/DELETE /api/chief/checks/{id}`, `POST .../{id}/run`, and paginated
`GET /api/chief/triggers?check_id=&state=&before=`. `PUT` uses revision checking;
Run now takes an idempotency key. `POST /api/chief/triggers/{id}/state` takes
`open|routed|waiting_on_operator|done`, a bounded summary and task/ask/brief reference;
the authenticated receiving session is checked against the stored target, never a
body-supplied identity. No agent CRUD for checks. Keep new Hub routes closed until
the owner-only contract is agreed; the UI must not offer unsupported controls.
Sources reuses Goal #218's secret-free MCP names/transport/scope/status; presence
is not proof of authentication. A source switch/interval edits an ordinary check,
not connector configuration. Missing/unsupported inventory says so and links to
agent setup; there is no Connect/password/token form in Coral.

**Proof before UI review:** failing-first tests for target/role isolation, invalid
schedules/timezones, wake/holds, duplicate slots/restart, disabled Run now, coalescing,
reminder once, resolution ownership and durable state; source inventory contains no
secrets. Then #13254's real browser suite covers phone/200% text/both themes and
honest pending/error states. This note precedes code; #13253 is the server slice.
