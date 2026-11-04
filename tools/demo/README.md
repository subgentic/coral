# Coral demo film: sources and how to rebuild it

The demo film (a team of five agents launches on a small weather dashboard called Skyline, a goal is created, a busy Inbox, a document is reviewed and answered, an agent's diff, the phone) is recorded **headless from a real, throwaway Coral**, driven by scripts, then encoded with ffmpeg. Everything needed to re-record or change it is here. The videos themselves are not in git (only the small GIF, in `assets/demo/`).

**It is staged, and says so.** The agents are scripted mock agents (`coral-go/cmd/mock-agent`) named in story.json (Orchestrator, Backend, Frontend, Designer, Reviewer); the board posts, review documents, the agent's reply and its new version are sent by script with Coral's own commands; the diff is a real uncommitted change in a throwaway Go repo; the cost figures are the mock agents' sample usage. Slow waits are sped up in the encode. Do not present it as a recording of real vendor agents.

## What is where

```
tools/demo/
  README.md             this file
  scripts/
    env.sh              DEMO_ROOT and port, sourced by the others
    rig-up.sh           start a fresh isolated demo Coral, make the throwaway repo, sign in headless
    denv.sh             run a command against the demo Coral only (clean env, own HOME and data)
    asagent.sh          run a CLI as one of the mock agents (the names in story.json)
    login.mjs           one-time-link sign-in, saves work/state.json
    lib.mjs             Playwright helpers: one recorded context per beat, caption band, visible cursor
    take.mjs            the beats: b1 to b7, plus seed (fills the Inbox), prompts (themed permission prompts and a question), perm and drain (not recorded)
    setup.mjs           makes the throwaway project and launches the team from story.json
    hubclip.mjs         the closing public-page clip (loads and scrolls a page, signed out, types nothing)
    shot.mjs            a headless screenshot of one dashboard page (for looking, not for the film)
    stills.mjs          the two README review stills (a rig with the team, then take.mjs seed, then node stills.mjs <outdir>)
    seed-usage.py       invented 7-day usage history for the demo Coral's own database (Analytics charts); DEMO_ROOT marker required
    encode.sh           clips to the 16:9 master, the 9:16 phone cut and the GIF
  story.json            the example the film tells: team, agents, goal, tasks, the Inbox documents, the board chatter, the live comment, the code change
  seed/                 the documents and the code change those refer to
  storyboard/           plan.json and storyboard.html: the approved v1 plan (captions, beats, what is staged); it tells the first example (a "slug" package), the beats are the same
```

## Rebuild from a clean checkout

`DEMO_ROOT` is a scratch folder you made for the demo, with an empty file named `.coral-demo-root` in it (the scripts delete things under it and refuse a folder without the marker, `/` and your home folder). Never use `~/.coral`, never port 8420, never a real Coral's data. Run these from a normal terminal: the takes are headless browsers, but a build or a recording that opens an app window (the Coral app, the tray) does not belong here.

1. **Build the release you want to film** (dev build: no Terms screen), the tools into `$DEMO_ROOT/bin`:
   ```bash
   export DEMO_ROOT=/tmp/coral-demo; mkdir -p "$DEMO_ROOT/bin" && touch "$DEMO_ROOT/.coral-demo-root"
   cd coral-go && go build -tags dev -o "$DEMO_ROOT/bin/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/mock-agent ./cmd/coral-hook-agentic-state ./cmd/coral-hook-message-check ./cmd/coral-hook-session-start ./cmd/coral-hook-task-sync
   ```
2. **Playwright and headless Chromium**, into the scratch folder (Node 18 or later; the film was made with 1.62.1):
   ```bash
   npm install --prefix "$DEMO_ROOT" playwright@1.62.1
   PLAYWRIGHT_BROWSERS_PATH="$DEMO_ROOT/pw-browsers" "$DEMO_ROOT/node_modules/.bin/playwright" install chromium
   ```
3. **ffmpeg with libx264** at `$DEMO_ROOT/bin/ffmpeg` (or on `PATH`). A static build is fine; `pip install imageio-ffmpeg` ships one.
4. **A fresh demo Coral with no team** (beat 2 launches the team on camera). Use a short neutral `DEMO_ROOT` like `/tmp/coral-demo`: its folders appear on screen (the demo repo is `$DEMO_ROOT/home/projects/demo-app`, inside the demo HOME), so a long scratch path would end up in a frame:
   ```bash
   export PATH=$HOME/.local/bin:$PATH   # only if node is not on PATH
   NOLAUNCH=1 tools/demo/scripts/rig-up.sh
   ```
   It builds nothing and touches only `$DEMO_ROOT`; telemetry is off and the cloud is off. The mock agents' CLI path is set to `mock-agent`.
5. **Record the takes**, in order, from `tools/demo/scripts`:
   ```bash
   export PLAYWRIGHT_BROWSERS_PATH="$DEMO_ROOT/pw-browsers"
   node take.mjs b1 b2 seed b3 prompts b4 b5 perm b6 b7
   node hubclip.mjs          # the public page at the end (an outward request: loads coralhub.dev once) ...
   node endcard.mjs          # ... or a plain end card instead (then encode with ENDING=card); a live page can go stale
   ```
   Each beat writes `work/clips/<beat>/*.webm`. A beat that fails closes its clip and prints `FAILED <beat>`.
6. **Encode**: `tools/demo/scripts/encode.sh` (`ENDING=card tools/demo/scripts/encode.sh` for the plain end card) writes `$DEMO_ROOT/out/coral-demo-16x9.mp4` (1:41), `coral-demo-9x16-phone.mp4` (21 s) and `coral-demo-inbox.gif`. Keep the GIF under about 5 MB (the one in the repo is 2.6 MB).
7. **Stop the demo Coral**: `tools/demo/scripts/rig-up.sh stop` (it stops the server it recorded, and only if that process is still this demo's own server; a reused pid is left alone).

## The leak check

While a beat is recorded, `lib.mjs` scans the page twice a second (visible text, titles, aria-labels, placeholders) for the host's home folder, a scratch or agent-scratchpad path, a macOS temp folder, a session id (a UUID), a board id (`b-` and 8 or more letters or digits), a long hex digest or a `coral://` link. If one shows, the beat fails (`FAILED bN: leak on screen in bN: ...`) after its clip is closed, so a path cannot reach the film unnoticed. `node selftest.mjs` proves the check fires (pages showing the home folder, a session id, a board id or a digest must fail; a clean page, including words like "b-tree", must pass); run it after changing `lib.mjs`. It is a text check: it does not read pixels, so a path drawn into an image is not caught.

## Iterating

- **Change a caption**: edit the `t.cap("...")` line in the beat in `take.mjs`, then re-record that beat.
- **Re-record one beat**: beats 1 and 2 need a rig without a team (`NOLAUNCH=1 rig-up.sh`); beats 3 to 7 need the team (run beat 2 first, or `rig-up.sh` without `NOLAUNCH`). Beat 4 uploads documents with fixed names, so start a fresh rig for it; `perm` should run once per rig (a second one stacks a second prompt; `drain` answers stale ones).
- **Change the timing**: the `SP_*` speed-ups at the top of `encode.sh`. The GIF's start (33 s) and length (23.6 s) follow them.
- **Change the story**: edit `storyboard/plan.json` and `storyboard.html` (hand-written, no tooling needed), then the beats.
- **Change the example**: edit `story.json` (team, agent names, goal, tasks, Inbox documents, chatter, the live comment) and the files in `seed/` it names; nothing else has to change.
- **Seed text**: `seed/*` and the `.new` code files. Use sample names and text only: no real names, paths, tokens or spend on screen.

## Things to know

- The chat pane shows the mock agent's canned line ("Hi! I'm mock-agent, a stand-in for a real agent…") and the phone prompt reads "Wants to run: rm -rf build": both are the mock's fixed text.
- The phone is a phone-sized headless browser (430×932), not a real phone; the 9:16 cut is scaled up from it.
- The Inbox does not always live-update an open document, so beat 4 reloads and reopens it if the agent's reply has not appeared in 7 seconds.
- `storyboard/` was planned with the discipline of [demo-director](https://github.com/precious112/demo-director) (MIT, pinned at `97a7ca9cf57a31069046f90e5714e4e2ccbd1775`); its scripts are not used and nothing of it is vendored here. The film is rendered by `take.mjs` and `encode.sh`, not by its engine.
- Chromium, Playwright and ffmpeg are downloaded by you, into `$DEMO_ROOT`; none is checked in.
