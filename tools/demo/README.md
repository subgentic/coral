# Coral demo film: sources and how to rebuild it

The demo film (a team launches, a goal is created, a document is reviewed from the Inbox, an agent's diff, the phone) is recorded **headless from a real, throwaway Coral**, driven by scripts, then encoded with ffmpeg. Everything needed to re-record or change it is here. The videos themselves are not in git (only the small GIF, in `assets/demo/`).

**It is staged, and says so.** The agents are scripted mock agents (`coral-go/cmd/mock-agent`) named Orchestrator, Developer and Reviewer; the board posts, review documents, the agent's reply and its new version are sent by script with Coral's own commands; the diff is a real uncommitted change in a throwaway Go repo; the cost figures are the mock agents' sample usage. Slow waits are sped up in the encode. Do not present it as a recording of real vendor agents.

## What is where

```
tools/demo/
  README.md             this file
  scripts/
    env.sh              DEMO_ROOT and port, sourced by the others
    rig-up.sh           start a fresh isolated demo Coral, make the throwaway repo, sign in headless
    denv.sh             run a command against the demo Coral only (clean env, own HOME and data)
    asagent.sh          run a CLI as one of the mock agents (Orchestrator, Developer, Reviewer)
    login.mjs           one-time-link sign-in, saves work/state.json
    lib.mjs             Playwright helpers: one recorded context per beat, caption band, visible cursor
    take.mjs            the beats: b1 to b7, plus drain and perm (not recorded)
    hubclip.mjs         the closing public-page clip (loads and scrolls a page, signed out, types nothing)
    shot.mjs            a headless screenshot of one dashboard page (for looking, not for the film)
    encode.sh           clips to the 16:9 master, the 9:16 phone cut and the GIF
  seed/                 the review documents and the code change the agents "make"
  storyboard/           plan.json and storyboard.html: the approved plan (captions, beats, what is staged)
```

## Rebuild from a clean checkout

`DEMO_ROOT` is an empty scratch folder you own. Never use `~/.coral`, never port 8420, never a real Coral's data. Run these from a normal terminal: the takes are headless browsers, but a build or a recording that opens an app window (the Coral app, the tray) does not belong here.

1. **Build the release you want to film** (dev build: no Terms screen), the tools into `$DEMO_ROOT/bin`:
   ```bash
   export DEMO_ROOT=$HOME/coral-demo-work; mkdir -p "$DEMO_ROOT/bin"
   cd coral-go && go build -tags dev -o "$DEMO_ROOT/bin/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/mock-agent ./cmd/coral-hook-agentic-state ./cmd/coral-hook-message-check ./cmd/coral-hook-session-start ./cmd/coral-hook-task-sync
   ```
2. **Playwright and headless Chromium**, into the scratch folder (Node 18 or later; the film was made with 1.62.1):
   ```bash
   npm install --prefix "$DEMO_ROOT" playwright@1.62.1
   PLAYWRIGHT_BROWSERS_PATH="$DEMO_ROOT/pw-browsers" "$DEMO_ROOT/node_modules/.bin/playwright" install chromium
   ```
3. **ffmpeg with libx264** at `$DEMO_ROOT/bin/ffmpeg` (or on `PATH`). A static build is fine; `pip install imageio-ffmpeg` ships one.
4. **A fresh demo Coral with no team** (beat 2 launches the team on camera):
   ```bash
   export PATH=$HOME/.local/bin:$PATH   # only if node is not on PATH
   NOLAUNCH=1 tools/demo/scripts/rig-up.sh
   ```
   It builds nothing and touches only `$DEMO_ROOT`; telemetry is off and the cloud is off. The mock agents' CLI path is set to `mock-agent`.
5. **Record the takes**, in order, from `tools/demo/scripts`:
   ```bash
   export PLAYWRIGHT_BROWSERS_PATH="$DEMO_ROOT/pw-browsers"
   node take.mjs b1 b2 b3 b4 b5 drain perm b6 b7
   node hubclip.mjs          # the public page at the end (an outward request: loads coralhub.dev once)
   ```
   Each beat writes `work/clips/<beat>/*.webm`. A beat that fails closes its clip and prints `FAILED <beat>`.
6. **Encode**: `tools/demo/scripts/encode.sh` writes `$DEMO_ROOT/out/coral-demo-16x9.mp4` (1:41), `coral-demo-9x16-phone.mp4` (21 s) and `coral-demo-inbox.gif`. Keep the GIF under about 5 MB (the one in the repo is 2.6 MB).
7. **Stop the demo Coral**: `kill "$(cat $DEMO_ROOT/work/server.pid)"`.

## Iterating

- **Change a caption**: edit the `t.cap("...")` line in the beat in `take.mjs`, then re-record that beat.
- **Re-record one beat**: beats 1 and 2 need a rig without a team (`NOLAUNCH=1 rig-up.sh`); beats 3 to 7 need the team (run beat 2 first, or `rig-up.sh` without `NOLAUNCH`). Beat 4 uploads documents with fixed names, so start a fresh rig for it; `perm` needs `drain` before it, so the phone shows exactly one prompt.
- **Change the timing**: the `SP_*` speed-ups at the top of `encode.sh`. The GIF's start (33 s) and length (23.6 s) follow them.
- **Change the story**: edit `storyboard/plan.json` and `storyboard.html` (hand-written, no tooling needed), then the beats.
- **Seed text**: `seed/*.md` and the `.new` code files. Use sample names and text only: no real names, paths, tokens or spend on screen.

## Things to know

- The chat pane shows the mock agent's canned line ("Hi! I'm mock-agent, a stand-in for a real agent…") and the phone prompt reads "Wants to run: rm -rf build": both are the mock's fixed text.
- The phone is a phone-sized headless browser (430×932), not a real phone; the 9:16 cut is scaled up from it.
- The Inbox does not always live-update an open document, so beat 4 reloads and reopens it if the agent's reply has not appeared in 7 seconds.
- `storyboard/` was planned with the discipline of [demo-director](https://github.com/precious112/demo-director) (MIT, pinned at `97a7ca9cf57a31069046f90e5714e4e2ccbd1775`); its scripts are not used and nothing of it is vendored here. The film is rendered by `take.mjs` and `encode.sh`, not by its engine.
- Chromium, Playwright and ffmpeg are downloaded by you, into `$DEMO_ROOT`; none is checked in.
