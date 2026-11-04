# ci: the test-job queue for this Mac and the Mac mini

Goal #221, task #13402. One heavy job at a time per machine, in priority order, with its result posted to the job's task. No daemon: a lock-and-poll loop.

```sh
ci submit --machine mac|mini --priority release|operator|perf|review|normal --task <task id> [--timeout S] [--cwd DIR] -- <command...>
ci run    --machine mac|mini [--once] [--poll S] [--no-post]     # take the best pending job when the machine is free
ci status [--json]                                               # running and queued jobs, per machine
ci cancel <job id> [--force]                                     # a pending job; yours unless --force
ci install                                                       # copy the tool to ~/ci-queue/bin (a stable path for every agent) with a `ci` wrapper
```

## How it works

- A job is a JSON file in `~/ci-queue/<machine>/pending` (`CI_HOME` moves the folder). Order: priority (release, operator, perf, review, normal), then the oldest first.
- `ci run --machine M` takes the best pending job only while it holds the machine's lock and the machine is idle:
  - the lock for `mac` is the directory `~/ci-queue/mac.lock` (the same `mkdir` protocol as the mini's `mini-lock`, with a `pid` file: a lock whose runner is gone is taken over; a lock with no pid yet is never taken);
  - for `mini` the lock is the mini's own `mini-lock` and the idle check its `mini-idle` (in `~/coral-test/bin` on the mini, see the `testing-on-the-mac-mini` skill); the job runs through `ssh mini` (`CI_SSH` replaces the ssh command) in `~/coral-test/<owner>` unless `--cwd` says otherwise;
  - idle on this Mac means: no suite runner, `go test`, test binary or headless Chrome younger than 4 hours (older ones are leftovers of earlier runs and do not count).
- The job runs in its own process group with a time limit (default 30 minutes, at most 2 hours). At the limit its whole group gets TERM, then KILL; the result is exit 124 and 'TIMED OUT'. Only the job's own processes are touched.
- The log is kept in `~/ci-queue/<machine>/logs`. The runner posts to the task: `@owner ci job ID on MACHINE (priority): PASSED|FAILED|TIMED OUT, exit=N, Ns`, the command, the log as a Coral artifact (an untagged link) and the last 12 lines. The post is made as whoever runs `ci run`, with their `coral-board` and `coral-agent`.
- Run `ci run --machine mac` and `ci run --machine mini` in the background (for example `nohup ci run --machine mac > /dev/null 2>&1 &`). Without a runner a job just waits.

## Rules built in

- The job gets a scrubbed environment: no `CORAL_*`, `CLAUDE*`, `ANTHROPIC*`, `TMUX` or `SSH_AUTH_SOCK` of the submitter; an isolated `TMPDIR` and `CORAL_DATA_DIR` (under `/private/tmp/ci-<owner>/<job>` here, `/private/tmp/coral-test-<owner>/<job>` on the mini, removed after the job); `CORAL_TELEMETRY_DISABLED=1`; Go and Node on the `PATH`.
- A command that names `~/.coral`, port 8420, `pkill`, `killall`, `sudo`, `open -...`, the tray or the app, `launchctl` or `coral open` is refused at submit time. The job's own command must start its server on a free port with `--cloud-url off --no-browser` (the suite runner `tests/frontend/run_cdp_suites.mjs` does) and run Chrome headless.
- It never starts a window, never touches the real Coral, and never kills anything outside the job's own process group.
- Added after Security's review (#13408):
  - `CORAL_URL` in a job is `http://127.0.0.1:1` (nothing answers there), so a scratch `coral-board` or `coral-agent` inside a job cannot reach the live board.
  - A job id must be exactly `<13 digits>-<4 hex>` at `cancel` and at run time, and a pending file whose name differs from its id is set aside (`done/refused-*`), never used to build a path. The job's temp folder is removed only when its real path is inside its owner's folder under `/private/tmp`.
  - The job file is linted again when it runs (the denylist, `~/.coral` in the folder, task number, timeout, owner name, machine, priority): a failing job is finished as `refused` and never starts.
  - Owner names are reduced to `a-z`, `0-9` and `-` at submit.
  - When `ci run` is stopped (TERM, HUP, Ctrl-C) the job's process group is stopped first, the job is recorded as `stopped` and the lock released. On the mini the ssh has `ServerAliveInterval=15` and `ServerAliveCountMax=3`, and a runner that loses the connection runs `_stop <job id>` over a new ssh to stop the job's group there (the group id is kept in `~/ci-queue/pgids/<job id>` while the job runs).
  - The posted text never contains `@` (nobody is mentioned by a job's output or command).

## Limits (read before relying on it)

- The denylist is a typo guard, not a security boundary: quoting (`.cor""al`), a script file or an environment variable get past it. The queue is for agents of one team that mean well; it keeps accidents out.
- The job runs as the same user with the real `HOME`, and variables such as `GH_TOKEN` or `AWS_*` still pass through (only `CORAL_*`, `CLAUDE*`, `ANTHROPIC*`, `TMUX` and `SSH_AUTH_SOCK` are removed). Fine for same-user agents; do not queue a job whose command prints its environment.
- A job that a second runner took first is not run twice: the move from `pending/` to `running/` is the claim, and the runner that loses it returns `taken` without running anything (pinned by a test that makes the move fail; two real runners on one machine are not the setup, one runner per machine is).
- The run-time lint repeats the submit-time denylist, so it is advisory too: a script file or a quoted form (`p"kill"`) gets past it, and a test body can run anything its command starts. The real protection is review of what is queued, the closed `CORAL_URL`, the scrubbed environment and the isolated folders.
- The mac lock's takeover of a dead runner's lock has a narrow race: two runners that both see the dead pid at the same moment can remove each other's new lock (the slower one's `rmtree`). It needs two runners started on the same machine, which the setup does not do (one runner per machine).

## Examples

```sh
ci submit --machine mini --priority perf --task 13402 --cwd ~/coral-test/qa-engineer/coral-go -- go test -count=1 ./internal/safego
ci submit --machine mac --priority review --task 13402 --cwd /path/to/worktree/tests/frontend -- node run_cdp_suites.mjs --only auth_local_open --retries 0
ci status
```

## Tests

`python3 -m unittest discover -s tests/ci -v`: no network, no Coral, nothing outside a temp folder; `ps`, `coral-board`, `coral-agent` and `ssh` are stubs. `CI_PY=<a mutated copy of ci.py>` runs the same tests against a broken copy (how the failing-first checks were made).

## Not done

No fairness between teams, no queue view in the dashboard, no job retry, no dependency between jobs: that is the Lead Developer's design (#13403). A job that crashes the machine leaves its `running/` file and the lock for the next `ci run` to find (the mac lock is taken over once its pid is dead; a stuck mini lock needs `mini-lock release ci-runner --force`).
