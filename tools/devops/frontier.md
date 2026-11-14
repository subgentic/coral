# frontier: the Windows test box

`ssh frontier` (cmd shell). Windows 11, 48 cores, Go 1.27.3, git, Chrome
(`C:\Program Files\Google\Chrome\Application\chrome.exe`), Node under `D:\coral-team-cache\tools\node` (v26, the Windows team's copy).
Operator rule: all work on D:, nothing on C:. No secrets on the box.
The box is the Windows team's. Their live Coral runs on port 8450 with data in
`C:\Users\cknor\.coral`, and our ssh user is the same Windows user, so
`CORAL_DATA_DIR` and a port in 9500-9599 are the only isolation: never 8420/8450,
never `~\.coral`, never a copy of a `sessions.db`. Do not touch `D:\coral-team-cache`.

Use it for Go packages, anything Windows-specific (paths, process handling) and,
since Node is installed, a CDP browser suite. Claim `frontier-go` (2 slots, 45 min
lease), run and release in one command, and post START/END naming frontier.

## Setup

No installs. Copy Node into your run folder (a copy, no junctions):
`xcopy /e /i /q D:\coral-team-cache\tools\node D:\coral-link-runs\<run>\node`.

## Environment for every run

```bat
set PATH=D:\coral-link-runs\<run>\node;C:\Program Files\Git\cmd;C:\Program Files\Go\bin;%PATH%
set GOCACHE=D:\coral-link-runs\<run>\gocache
set GOTMPDIR=D:\coral-link-runs\<run>\gotmp
set GOPATH=D:\coral-link-runs\<run>\gopath
set GOMODCACHE=D:\coral-link-runs\<run>\gopath\pkg\mod
set npm_config_cache=D:\coral-link-runs\<run>\npm-cache
set TEMP=D:\coral-link-runs\<run>\tmp
set TMP=D:\coral-link-runs\<run>\tmp
set CORAL_TELEMETRY_DISABLED=1
set CHROME_BIN=C:\Program Files\Google\Chrome\Application\chrome.exe
```

Test servers: `CORAL_DATA_DIR` under `D:\coral-link-runs\<run>\data`, `--cloud-url off`,
`--no-browser`, a non-default port. Never `%USERPROFILE%\.coral`.

## Where to clone

Your own folder `D:\coral-link-runs\<run>` (a unique name per run; Node, caches, source and data all live in it), never a shared
checkout. The box has no GitHub credentials: from your machine, make a tarball of
the commit and copy it over:

```bash
git archive --format=tar.gz -o <run>.tgz <sha>
ssh frontier "mkdir D:\coral-link-runs\<run>"
scp <run>.tgz frontier:D:/coral-link-runs/<run>/src.tgz
ssh frontier "cd /d D:\coral-link-runs\<run> && mkdir src && tar -xzf src.tgz -C src"
```

## Run

```bat
cd /d D:\coral-link-runs\<run>\src
npm --prefix tests\frontend ci
npm --prefix tests\frontend run test:cloud
node tests\frontend\run_cdp_suites.mjs --only <suite>_browser --retries 0
```

A RETRY, FLAKY or TIMEOUT line is red, as everywhere.

## Cleanup

Delete the whole run folder when done: `rmdir /s /q D:\coral-link-runs\<run>`.
Caches live inside it, so nothing is left behind.
