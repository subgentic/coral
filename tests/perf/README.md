# Performance baseline harness (#3851, supports #3845–#3847)

One reusable command that reproduces the #3833 measurement each time and prints the **same
table**, so the perf tasks have a stable baseline to compare against. It merges Security's
#3833 load setup (bulk dataset, dashboard-tab simulator, pprof, strace execve census) with
QA's #3713 latency harness (the seeder and `measure.sh` under `tests/latency/`).

**Measurement only — no product change.** Epoch-only and opt-in: it seeds a large dataset,
starts real tmux sessions, and runs pprof + strace, so it must never run on the operator's
Mac or in the normal suite. It never touches `~/.coral` or `:8420`; the server runs with an
isolated `CORAL_DATA_DIR`, `CORAL_CLOUD_URL` unset and `--cloud-url off`. It kills **only the
PIDs it started** (no pattern-kills) and removes its temp dirs on exit.

## Run (on epoch)

```bash
# against the checked-out ~/coral
QA_PERF_RUN=1 bash tests/perf/run_perf.sh

# or against an isolated worktree at a specific commit (recommended)
QA_PERF_RUN=1 GO=$HOME/go-install/go/bin/go REPO=/path/to/worktree bash tests/perf/run_perf.sh
# On epoch the data lands under /sd2/$USER/qa-tmp and is removed on exit (see the team's internal notes); KEEP_PERF_DATA=1 keeps it.
```

The script re-execs itself under `nice -n 10`. Env overrides: `GO, REPO, WORK, QA, PORT,
PPROF_PORT, N, NSESS, NBIG, BIGMB, SMALLKB, FILESN, NMSG, NEVENT, TABS, WARMUP_S, CPU_S,
LOAD_S, STRACE_S` (defaults match #3833: 40 sessions, 300k board messages, 250k events, 2
tabs, a 150 s warm-up, 60 s CPU profiles, a 180 s load phase, 120 s strace windows).

## What it prints (the table)

- **Startup-to-serving**: seconds from launching the server to the first `/api/health` 200,
  with realistic read cursors (most subscribers near the head; `bulk.py` seeds them, because
  all-at-0 makes startup not serve for minutes — itself a finding, #3833 item 4).
- **CPU per component** (idle, and under the tabs): the flat/cum% of the top functions from
  `go tool pprof -top` on the 60 s CPU profiles.
- **Latency per endpoint**: p50/p95/p99/max for the dashboard's hot reads, idle and under the
  tabs (reuses `tests/latency/measure.sh`).
- **Fork/exec rate**: execve per second idle and under load, from the server started under
  `strace -f -e trace=execve` (strace cannot attach to a running process on epoch), plus a
  per-program breakdown (tmux / git / ps / uname / …).

## Files

- `run_perf.sh` — the orchestrator (build, seed, phases A idle / B tabs / C strace, table, cleanup).
- `bulk.py DATA_DIR TARGETS_JSON [NMSG] [NEVENT]` — adds the board/event backlog and seeds read cursors (run with the server stopped).
- `load.py BASE TARGETS_JSON TABS SECONDS` — the dashboard-tab simulator (ws feed + the real pollers).
- `table.py OUT CORAL_BIN …` — assembles the one table from the collected artifacts.

It reuses `tests/latency/seed` (the dataset seeder, which also writes `targets.json`) and
`tests/latency/measure.sh` (the percentile sampler), so the two harnesses stay in step.

## Pitfalls baked in (from #3833)

- Never `pkill -f` a path over ssh (it matches the ssh command too); kill recorded PIDs only.
- `wait` on specific PIDs, not a bare `wait` (which also waits on the server you started).
- Long jobs start with `setsid … < /dev/null` so an ssh session doesn't stay attached.
- strace is **started with** the server, not attached (epoch's `ptrace_scope`).
- Record the machine load average with every table (epoch is shared with other agents' runs).

## The big-board scale run (#4669)

`scale.sh` with the long-lived board: `AGENTS=250 TABS=5 TAB_ROLES=chat,chat,board,list,list BOARD_MSGS=20000
BOARD_TASKS=3000 TRANSCRIPT_TURNS=300 LOAD=1800 PERF_RUN=1 bash tests/perf/scale.sh` (epoch only). Before any agent starts
`scale_seed.py` posts the messages and creates the tasks on team 1's board (`scale1`) through the real API and cancels about two
thirds of the tasks; the server is then stopped and started again on that database and `startup.txt` gets the seconds to
`/api/health` and to the first agent list. The mock agents write transcripts (`MOCK_AGENT_TRANSCRIPT=1`) and
`scale_transcripts.py` grows every live session's file to a real-shaped length (log-normal turns, tool calls and results of up
to tens of KB), in the isolated HOME only (it refuses the account's own `~/.claude`). `scale_load.py` then runs the tabs by
role (two open chats on the largest transcripts, one on the busy board, the rest on the agent list) for `LOAD` seconds and
writes the p50/p95/p99 per request, the RSS and goroutine series (a point every 30 s) and the CPU, heap, allocs, mutex and
block profiles. `RESTART_END=1` times a second start on the finished data. SQLite lock waits: `lock-errors.txt` counts
`database is locked` lines, and a separate short run with `CORAL_DEBUG_PHASES=1` logs the pool wait counters.

## The server-performance run (#5023)

`AGENTS=40 TEAM_SIZE=8 TABS=4 TAB_ROLES=list,chat,board,list TRANSCRIPT_TURNS=300 WARMUP=60 CPU=300 LOAD=700 POST_RATE=2
PERF_RUN=1 bash tests/perf/scale.sh` (epoch only): 40 mock agents in five teams of 8 writing transcripts, four tabs, a busy
board. `TEAM_SIZE` is the agents per team (25 by default). With `LOAD=700` the CPU profile covers seconds 200 to 500, after the
first scan of the seeded transcripts; with `LOAD=330` it starts at second 15 and holds that scan. `allocs-window-top.txt` is
what was allocated during the CPU profile (`allocs-start.pprof` and `allocs-end.pprof`, diffed with `-base`), not since the
start, so the steady state is not hidden under the first scan. `load.json` has `slow`: every request of 0.5 s or more with its
start in seconds from the load's start, to line a stall up with `server.log`. A stall on a loaded epoch is the machine's:
`machine.txt` has its load average, and a stall seen once at a load of 12 did not come back at a load of 1.

## The big-board fixture and baseline (#13154, goal #215): runs on a Mac

`bigboard_seed.sh` makes the fixture the performance sprint measures against: 30 mock agents in one team, 2,000 tasks, 50,000 board
messages, 20,000 artifact uploads (200 files x 100 versions, all tagged for review, through the agents' own session tokens) and a 35,000-change
git repo (`PERF_RUN=1 FIXTURE=<empty folder> bash tests/perf/bigboard_seed.sh`; `SMALL=1` is a one-minute smoke). A real server refuses
more than 100 uploads per agent per hour, so only the seed server is built with that window raised, by `go build -overlay` (a patched copy in a
temp folder; nothing in the repo changes). `bigboard_run.sh` copies the fixture's data, starts the plain build on the copy and measures it
(`PERF_RUN=1 FIXTURE=... OUT=... [HUB=1] [IDLE_S=60] bash tests/perf/bigboard_run.sh`): `bigboard_measure.mjs` loads the dashboard in a
headless Chrome and records every request (path with ids folded, p50/p95/max ms, bytes, status) at load and while idle, then times an agent
switch, 83 keystrokes in the composer (with the page's long tasks), the Files panel and opening a file from Needs you. With `HUB=1` the same
page is measured through a second `coral --hub` that has the first added as a remote server over loopback. `bigboard_table.py` writes
`ranked.md`, worst first. Both are heavy runs: one at a time, announced (HEAVY RUN START/END). They use their own data folders and ports
(8741 to 8743), `--cloud-url off`, `--no-browser`, the mock-agent sandbox and never `~/.coral` or `:8420`.

Known limits: about 2% of the seeded messages are refused (an @mention of a name that is not on the board); the seeded agents are asleep or
gone when the fixture is measured (the server is stopped after the seed), so the agent rows are real but nothing is typing into them.

### Typing attribution on the big-board rig (#13156)

Add `LIVE=30 HUB=1 TYPING_TRACE=1` to `bigboard_run.sh` to capture 200 synthetic characters in both the composer and the terminal,
with Files and the sidebar visible. This uses the actual selected agent/server identity, a CDP timeline and CPU samples.
It starts no extra server. The measurement refuses a sleeping agent, disabled input or disconnected terminal; the fixture's
recorded sessions alone are insufficient. Wake/restart mock agents on the rig's isolated copy first. No newline or Send is issued.

Each local/Hub output gets a `*-typing/` folder containing compressed Chrome traces, CPU profiles and a JSON summary of every
main-thread task longer than 50 ms, its nested events and sampled source owners. Only events overlapping the marked typing burst
are budgeted; exact microsecond task durations are kept alongside rounded display times, and incomplete renderer tasks cannot certify a clean capture; unrelated renderer processes and nested duplicate tasks are excluded. Key-to-frame timing includes CDP overhead.
Set `TYPING_GATE=1` with `TYPING_TRACE=1` to fail the measurement and outer runner for a setup error or any task over 50 ms. Profiling is enabled
in this mode, so retain machine/load details when comparing timings. The long-task attribution parser has light checks:
`node --test tests/perf/typing_trace.test.mjs`. Trace mode makes one Chrome startup attempt and does not retry a failed measurement.
Pass `BIN=<plain candidate coral>` and `CANDIDATE_REV=<sha>` to measure a candidate on a copy of the existing fixture; the default still uses the fixture build.
The default baseline measurement keeps QA’s existing retry policy without the typing opt-in.

Safety notes (Security's read of the rig, #13154): the scripts stop a tmux server only through `stop_private_tmux` in `bigboard_lib.sh`, which refuses any socket under a real Coral
folder (`~/.coral`, `$CORAL_DIR`, any `.coral/`) or at a path that is not `<run folder>/data/tmux.sock`; a private socket made by the run's own server is exempt from the "no tmux
kill-server" rule (#12836) because nothing else can be attached to it. `bigboard_serve.sh stop` stops a PID from `RUN_DIR/pid` only if its command line is a coral with that run's `--home`.
The API keys go to curl through mode-600 header files, not the command line. The pprof listeners (`127.0.0.1:8744` and `:8747`) serve heap data to any local user while the run lasts.
