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
