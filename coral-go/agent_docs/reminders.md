# Reminders (#19162)

A reminder is a note Coral types to an agent at a time you choose. It stays open until the agent runs `coral-board remind done <id>`, and Coral tells the agent once more if it is still open 15 minutes later.

```
coral-board remind add "Check the soak run" --in 2h
coral-board remind add "Stand-up notes" --weekdays 09:00 --tz Europe/Berlin
coral-board remind add "Weekly catch-up" --weekly "Mon 09:00" --tz Europe/Berlin
coral-board remind add "Look at CI" --every 15m
coral-board remind list | show <id> | done <id> | cancel <id>
```

Times: `--in 2h`, `--at 2026-11-18 09:00` (one time, at most 364 days ahead), `--every 5m|15m|30m|60m`, `--daily HH:mm`, `--weekdays HH:mm`, `--weekly "Mon 09:00"` (one day a week, `Mon` to `Sun`, then `HH:mm`; uses `--tz` or this computer's time zone, and a week the clocks change still fires at that local time on the wall. If Coral was off when a weekly slot came due, it fires once when Coral starts again).

## Who may do what

- **Set:** the Operator (for any agent), an agent (for itself: at most 20, repeating no faster than every 15 minutes), the team's Orchestrator (for a member, only while the Operator's grant is on: at most 50 per team). Never through Coral Hub.
- **Read:** the agent it is for, and the team's Orchestrator seat, which reads every reminder for its team, the Operator's included.
- **Mark done:** the agent it is for, the seat, the Operator.
- **Cancel:** the Operator and the seat cancel any. An agent cancels only a reminder it set for itself; a reminder the Operator or the Orchestrator set for it is answered `403 not_yours_to_cancel`, and the agent marks it done instead.

## A one-time reminder and a computer that was off

A one-time reminder fires once. If the computer was off at its time, it fires on the next start of Coral (Coral checks for missed one-time reminders each time it polls, not only the scheduler's one-day look-back), however long the computer was off. It does not wait for a yearly schedule line to come round. After it has fired it is switched off; a fired one-time reminder cannot re-arm itself the next year, even if its job is switched on again.

## A task's reminder time (`task add --remind-at`)

`coral-board task add ... --remind-at <time>` keeps working. When the time comes, an open, unparked task's assignee (or the team's Orchestrator when nobody is assigned) is reminded once, within the board's limits, and the reminder goes out as a one-time reminder of origin `task` on the same machinery as the ones above: it shows in `coral-board remind list`, is told after a restart if its minute passed while Coral was off, and is held while the Operator has switched that agent's reminders off (it is told once when they are switched back on). Only the Operator or the team's Orchestrator can cancel it; an agent marks it done with `coral-board remind done <id>`.

## From the Operator

An agent's page (Team, Agents) has a Reminders section: its reminders with Cancel, and a form (**Instruction**, **Schedule**, **Repeat every**, **Day**, **Date and time** / **Time**, **Save reminder**) that adds a one-time reminder (**Once**) or a repeating one (**Repeat** every `5 minutes`, `15 minutes`, `30 minutes` or `Hour`; **Daily**; **Weekdays**; or **Weekly** on **Day** `Monday` to `Sunday` at **Time** in this computer's time zone). It is not available through Coral Hub.
