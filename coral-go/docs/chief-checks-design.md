# Chief checks: design for #13252 / Goal #220

A check schedules an instruction to an existing agent. Coral stores the instruction,
schedule and progress; the agent uses its own connectors. **Coral neither accepts
credentials nor queries mail, calendars or other connector services.** No credential
fields or raw connector configuration. Reject instruction secrets and sign-in links
visibly (never silently redact); cap/clean/redact agent results before storage.
Fail closed if checking is unavailable; never log either raw text. The approved
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
check, and never silently retarget a renamed/replaced agent. Re-check the exact
live membership at create/edit/every delivery. Use the normal board/notification
path and cross-team controls, from the reserved “Coral Task Queue” sender, addressed
only to that member. A fixed frame says “a check the Operator scheduled” and treats
the instruction as the Operator's own text, not a new permission grant.
`wake_if_asleep` is per-check consent, **off by default**; opted-in wakes use the
existing lifecycle, preserve permissions, and count against hourly and live-agent
caps (including reminder wakes). Without consent, sleeping is a visible held state;
missing/archived targets become a visible delivery error, not a replacement launch.
The idle-wake callback covers auto-sleep only: do not mistake it for this consent.
Prompt/permission holds still hold delivery; no direct terminal typing. Include the
trigger id and resolution command; clean/DefuseMentions instruction and name,
controls and marker text, keeping only the intended recipient live.

The session database and board database are separate. Add a board-side dedupe key
`(trigger_id, delivery_kind)` committed with its message, then acknowledge the outbox;
restart/retry must not duplicate the message. Deduplicate scheduler slots and Run now
requests too. A successful delivery completes the *scheduled run*, not the trigger.
Cap checks (100) and retained triggers (10,000); prune resolved history after 30
days and oldest resolved rows at capacity, never unresolved rows. If still full,
show a capacity failure. Keep one unresolved trigger per check: later ticks coalesce and show “already open”;
Run now returns that trigger rather than multiplying notifications. An explicit
retarget/edit affects subsequent triggers, not one already delivered.

**Resolution and reminders.** A trigger starts `open`, records delivery/error and
message ids, timestamps and `reminded_at`, and stays unresolved until `done`.
`routed` requires a task on the check's own board; `waiting_on_operator` requires
an existing ask created by this receiving session on that board. Both remain visible and owned by the receiving agent; their
linked task/ask supplies its normal reminder behavior. Only an unresolved `open`
trigger gets one reminder after 15 minutes, through the same durable delivery/wake
path; retries and restart cannot repeat it. Delivery and reminder failures are
recorded/shown as failures, never as “all clear.” The receiving session alone may report
progress/resolve; the Operator may inspect and resolve/reopen explicitly. Responses
are bounded summaries/references, never connector bodies or credentials. Summaries
are untrusted agent words kept on this computer, drawn with textContent only;
Coral never re-sends them or uses them to construct another message. Repeated
resolution is idempotent; disabled/deleted checks stop new fires but preserve triggers.

**Notification policy.** `only_if_found` requests silence for “nothing new”;
`every_time` requests a result each run; `daily_brief` requests inclusion in Chief's
next brief. Carry the policy in the instruction and persist the agent's reported
outcome. The agent itself posts any notice/ask/brief through its ordinary board
identity; Coral does not forward stored summaries. For daily brief, retain an unconsumed
result until the agent references its actual brief message; show “awaiting brief,”
not “notified.” A waiting-on-Operator result links the real ask in Needs you. No
push, quiet-hours scheduling or webhooks in this slice, and no silent “all clear”
when the agent/connector is unavailable.

**API and Sources.** Operator/person-only `GET/POST /api/chief/checks`,
`GET/PUT/DELETE /api/chief/checks/{id}`, `POST .../{id}/run`, and paginated
`GET /api/chief/triggers?check_id=&state=&before=`. `PUT` uses revision checking;
Run now takes an idempotency key. `POST /api/chief/triggers/{id}/state` takes
`open|routed|waiting_on_operator|done`, a bounded summary and task/ask/brief reference;
`VerifiedSession` alone supplies agent identity, checked against the stored target;
ignore a body-supplied identity. Bind this one agent-reachable path in the identity
and agent-route lists; other chief routes are person-only and “never” in the cloud
route golden. No agent CRUD for checks. Keep new Hub routes closed until
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

Security read #13273 cleared this design; the seven posted build conditions and
the Orchestrator’s 2026-11-04 amendment are acceptance requirements for #13253.
Server coding starts only after #13175 is submitted.
