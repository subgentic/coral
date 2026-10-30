# Release screenshot review

Every page of the dashboard, photographed at three widths for each release, filed as Coral artifacts on a
`UI review: vX.Y.Z` task, with the pages that changed since the last release first. A plain script from start
to finish: **no agent turn, no model, no tokens** (the operator's rule). Building it cost tokens once; every
release run after that costs none.

```
tests/release/screens/run.sh v2.0.7                      # the tag, or the current commit when there is no tag yet
tests/release/screens/run.sh v2.0.7 --ref ci/2.0.7-main  # a branch or commit that is the release candidate
tests/release/screens/run.sh v2.0.7 --themes dark,light  # both themes (dark is the default)
tests/release/screens/run.sh v2.0.7 --no-publish         # shots and comparison only, nothing filed
tests/release/screens/run.sh v2.0.7 --dry-run            # also builds the contact sheet and the task text; no board calls
```

## What a run does

1. **Builds** the release (its tag, `--ref`, or the current commit) with the dev tags in a worktree of its own, so
   the checkout it runs from is never touched, plus the board tools and the mock agent.
2. **Starts two private servers** on free ports: `--home` a fresh temp folder, `--host 127.0.0.1`, `--cloud-url off`,
   `--no-browser`; never `~/.coral`, never `:8420`. An isolated `HOME` and a stub for every agent CLI come first on
   `PATH` (`tests/lib/mock_sandbox.sh`), so a real CLI can never run.
3. **Seeds** the first one (`seed.mjs`) through the HTTP API and the real `coral-board` / `coral-agent` as mock
   agents: two teams with agents working, waiting, idle and asleep, a goal with tasks and artifacts, board
   messages, an HTML artifact, a workflow and its run, a scheduled job, a saved message, chats with long messages.
   Everything is made up in `seed.mjs`: no real data, no token in a shot. The second server stays empty (the
   first-run screens).
4. **Photographs** every page of `pages.mjs` (`shoot.mjs`, Playwright): 1440x900 (full), 900x900 (middle) and
   390x844 (phone: the mobile user agent and touch), full-page, the clock fixed, animations and the caret off,
   waiting for the app's own ready signal (`window.__coralReady`) and then for its requests to go quiet.
   A page that cannot be photographed is recorded (and listed on the sheet and the task), and the run goes on.
5. **Stops both servers and deletes their data** before anything is filed.
6. **Compares** each shot with the same shot of the previous release (`diff.mjs`, pixelmatch). More than
   `SCREENS_DIFF_PIXELS` (300) pixels and `SCREENS_DIFF_RATIO` (0.05%) different, or a different size, is
   "changed"; the pixels decide, nothing else.
7. **Keeps the shots** in `~/.cache/coral-screens/<version>/` (`SCREENS_CACHE`; never inside `~/.coral` or the
   repo): the next release is compared with them.
8. **Files them** (`publish.mjs`, as a CLI under the identity of whoever runs it):
   the contact sheet first (an HTML artifact: changed pages first with before, after and diff images, the rest
   folded), then each shot named `<page>__<width>.png` (`__light` added for the light theme) on the task.

## The page list is a census

`pages.mjs` is the one list. `census.test.mjs` reads the dashboard's own sources (`routes.js` and its tab and
folder lists, the views `app_routes.js` handles, the nav tabs in `index.html`, the Settings sections and the
dialogs in `modals.html`) and **fails when something has no page** or no reason (`ALIASES`, `NOT_PHOTOGRAPHED`),
so a new page cannot be skipped. Add the entry, and an opener in `openers.mjs` if an address is not enough.

```
cd tests/release/screens && npm ci && npm test    # census, diff, manifest and contact-sheet tests (no browser)
```

## Who runs it, and the task

The cheapest trigger is a shell step: **DevOps runs `tests/release/screens/run.sh vX.Y.Z` after
`verify-release`** (it is not wired into `tools/finish-release.sh`, which is outside this directory's scope; the
call is one line, `tests/release/screens/run.sh "$VERSION" || echo "screenshot run failed (never blocks)"`).
A launchd or cron watcher on the release machine works the same way; neither needs an agent. A failure never
blocks a release: `run.sh` only warns when filing fails, and its exit code is for the caller to ignore.

The upload is a CLI call under the runner's identity, and an upload links only to a task of the uploader. So
`publish.mjs` opens its own task: **`coral-board task add "UI review: vX.Y.Z" --self --goal 163`** (#11247, in
v2.0.7: any member of a board may open a task for itself, with a goal, one per title, at most five open), uploads to
it, and then hands it to the Operator if the runner may reassign (the orchestrator, the Operator), or completes it
with the contact sheet's link in the message. A `coral-board` without `--self` (before v2.0.7) falls back to a plain
add, which only the Operator or an orchestrator may do: then have the orchestrator create the task assigned to the
runner, and `publish.mjs` finds it (or takes `--task N`). A task of the same title that is already open and the
runner's is reused; a re-run after it was completed opens a new one. `SCREENS_GOAL` changes the goal (default 163).

## What a shot may show

The work folder, the HOME and the data folder of a run have the same neutral names every run
(`/tmp/coral-screens/...`), because some pages print them (a job's folder, an agent's terminal): a path that
changed per run would make every release look changed, and one under the runner's own home would name the person.
`shoot.mjs` also reads each page's text before photographing it and **refuses a shot that holds the runner's `HOME`
or `TMPDIR`** (a canvas-drawn terminal is not in the page text; the neutral names are what protect it; a page of
documentation may print an example `/Users/me`, so the check is for the runner's own paths only). The first v2.0.6 baseline predates this: its shots show
`/var/folders/.../T/coral-screens.XXXX` paths (no account name), so the first comparison flags the few pages that
print a path; later releases compare neutral with neutral.

Known limits: a failed run keeps `/tmp/coral-screens` (its data folders hold a throwaway API key until the next run
clears them); a port is picked just before the server starts, so another process could take it in between and the
run fails at the health check; one run at a time (`/tmp/coral-screens.lock`). The work folder and the lock are made mode 0700 by the run, and one that is a link, belongs to another account or has another mode is refused (`run_guard_test.sh` tests that), so a shared `/tmp` cannot hand the run a folder someone else prepared.

## The upload limit

The server lets one agent session upload **100 files and 512 MiB an hour**, refused ones included. So the script
paces itself (`SCREENS_UPLOADS_PER_HOUR`, default 80) and waits out a "rate limited" answer
(`SCREENS_MAX_WAIT_MIN`, default 300). After the first run only the shots that **changed** or are new are uploaded:
an unchanged page's thumbnail links to the previous release's artifact (`links.json` in the cache), so a release is
a few dozen files. The first run (the baseline, 200+ shots) takes about three hours of mostly waiting: run it
detached (`nohup ... &`). `--all` uploads every shot again.

## Needs

Go, Node 20+, git, Chrome (or `SCREENS_CHROME=/path/to/chrome`, or `npx playwright install chromium` with
`SCREENS_CHANNEL=chromium`), `npm ci` once here (Playwright, pixelmatch and pngjs are pinned in
`package-lock.json`), and for filing a `coral-board` and `coral-agent` signed in as the runner (`SCREENS_BIN=<dir>`).
