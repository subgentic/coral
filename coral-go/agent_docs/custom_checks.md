# Custom checks

A custom check is a script Coral runs for a team on a schedule. What it prints is said to one member as Coral's notice, once per key. The Orchestrator (or the Operator) adds checks with `coral-board health check`. **Nothing runs until the Operator approves it**: the approval is a question in Needs you with Approve and Deny, one click each.

## What the Operator approves

The question states, in words: the script's full path and its SHA-256, each argument, the folder, the schedule, who gets its lines, who it runs as, and whether it may write. Approving approves exactly that record. Change anything (the script's bytes, an argument, the folder, the schedule, `to`, `acts_as`, `may_write`) and the check is pending again, its live tokens end, and a new question replaces the old one. Files the script reads or runs itself are not covered: keep scripts small and self-contained.

The Operator approves on the computer the check runs on, never through Coral Hub.

## Add, change, pause, remove

```bash
coral-board health check add stale-prs --script /Users/me/checks/stale_prs.sh --dir /Users/me/repo --every 30m --arg --days --arg 7
coral-board health check list
coral-board health check change stale-prs --every 1h        # pending again until approved
coral-board health check pause stale-prs                     # and resume; resume needs the same approved record
coral-board health check remove stale-prs
```

`--to <member>` says who gets the lines (default: the Orchestrator). `--as <member>` is who the check runs as (default: whoever adds it); it is never the Operator. `--may-write` is off unless you pass it.

## What a script prints

One JSON object per line on stdout, at most 20 lines and 16 KB; stderr is dropped and stdin is closed.

```json
{"key":"pr-412","text":"PR 412 has waited 3 days for review","level":"warn"}
```

- `key` (letters, digits, `._:-`, up to 64): a key is said once; it is said again only after a run that does not print it.
- `text`: one line, cut at 200 characters. Coral marks it as an automated notice, never an instruction.
- `level`: `info` or `warn`.
- A run takes 20 seconds by default and at most 60. A script that fails is reported as one fixed line; its own words are not used.

Environment: only `PATH`, `HOME`, `TMPDIR`, `LANG` and three Coral variables: `CORAL_BOARD_URL`, `CORAL_BOARD` and `CORAL_CHECK_TOKEN`. Send the token as the `X-Coral-Check-Token` header.

## What a script may call

The token is made for each run and ends with it. It may read the team's tasks and members and search its messages. With `--may-write` approved it may also post to the board, add a task, comment on a task and reassign one, as the member it runs as, marked `[via check <name>]`, at most 5 a run and 6 an hour. It cannot ask the Operator anything, and everything else is refused.

## Four examples

**1. Reads something outside Coral (read-only).** Pull requests waiting more than three days:

```bash
#!/bin/sh
gh pr list --json number,createdAt |
  jq -c '.[] | select((now - (.createdAt | fromdate)) > 259200) | {key: ("pr-" + (.number|tostring)), text: ("PR " + (.number|tostring) + " has waited over 3 days for review"), level: "warn"}'
```

Add it with `--every 1h`. Each PR is said once.

**2. Watches the computer (read-only).** Less than 10 GB free (macOS `df -g`; on Linux use `df -BG`):

```bash
#!/bin/sh
free=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "$free" -lt 10 ] && printf '{"key":"disk-low","text":"Only %s GB free on this computer","level":"warn"}\n' "$free"
exit 0
```

Add it with `--daily 09:00 --tz Europe/Berlin`.

**3. Reads Coral's own API (read-only).** Tasks that have sat in review:

```bash
#!/bin/sh
curl -s -H "X-Coral-Check-Token: $CORAL_CHECK_TOKEN" "$CORAL_BOARD_URL/api/board/$CORAL_BOARD/tasks?full=1" |
  jq -c '.tasks[] | select(.status=="review_pending") | {key: ("review-" + (.id|tostring)), text: ("Task " + (.id|tostring) + " is waiting for review: " + .title), level: "warn"}'
```

Add it with `--every 30m --to Orchestrator`.

**4. Writes to the board (needs `--may-write`).** A weekly task for the member it runs as:

```bash
#!/bin/sh
curl -s -X POST -H "X-Coral-Check-Token: $CORAL_CHECK_TOKEN" -H 'Content-Type: application/json' \
  "$CORAL_BOARD_URL/api/board/$CORAL_BOARD/tasks" \
  -d '{"title":"Weekly dependency check","body":"Look for outdated dependencies.","priority":"low"}' >/dev/null
printf '{"key":"weekly-task-%s","text":"Added this week'"'"'s dependency task","level":"info"}\n' "$(date +%G-%V)"
```

Add it with `--daily 08:00 --tz Europe/Berlin --as Dev --may-write`. The approval question says it MAY WRITE as Dev, and each task it adds is marked `via check weekly-deps`. Keep a write check idempotent: the 6 an hour limit stops a loop, not a duplicate.
