# Auto-update check: v2.0.0 to v2.0.1 with real releases (#9030)

The updater is Coral's own: `coral-update check` finds the newest **promoted** release, verifies it and stages it; a person's click (Update and relaunch) installs it. This is how to prove that chain on the real releases, and what was and was not proved before v2.0.1 exists.

## What "finds" means

The updater takes no URL, version or hash from anyone: the repository and the Sigstore pins are compiled in. It lists the releases of the pinned repository and takes the highest-sequence `promote-<tag>-<n>` pre-release whose manifest (`promote.json`, with its `.sigstore.json` bundle) the promote workflow signed; that manifest names the release the package comes from. So **v2.0.1 is found only after it is promoted** (approved, `releases/latest`), never at the tag. Then it checks, in this order: the manifest's Sigstore bundle (certificate, log entry and timestamp, against the TUF-distributed trust root), the package's sha256 against `SHA256SUMS.txt` (itself signed), the version against the installed one (never a downgrade), and stages the package under `<data>/updates/staging/<version>`. A failure backs off (a network one 5 minutes, then 15, then an hour; a verification one an hour, doubling).

## The script

`tests/release/update_real.sh [--from v2.0.0] [--to v2.0.1] [--check-only] [--keep] [--timeout S]`, macOS. It downloads FROM's DMG (a release download, as a user's), checks it against `SHA256SUMS.txt` and codesign, copies the app to a folder of its own, starts the real tray with a fresh HOME and data folder (`CORAL_CLOUD_URL=off`, random port, `--backend tmux`, the stand-in agent of `smoke_macos.sh` as a tmux session), and drives the real update routes as the person does (`person-call`, a request signed with the data folder's command-line token).

| item | proves |
|---|---|
| 1 download | the DMG is the sha256 in `SHA256SUMS.txt`; codesign-valid |
| 2 start | FROM answers `/api/health`; the agent is a tmux session |
| 3 find | a check stages TO and it is verified; the relaunch is available with its acknowledgement token |
| 4 ask | an API key and an agent's token are refused; nothing starts |
| 5 apply | the person's request installs TO and relaunches: `/api/health` says TO, a new server pid, the old one gone |
| 6 install | Info.plist is TO, codesign-valid, spctl accepted, `coral-update status` says installed TO |
| 7 tmux | the agent's tmux session and pane process are the same (or, if TO bundles another tmux build, `tmux_agents_restart` said so and a session is there again) |
| 8 settled | a second check says up to date |

Items 5 to 8 need a machine that is thrown away (`RUNNER_ENVIRONMENT=github-hosted` or `--throwaway-machine`): the apply restarts Coral with `/usr/bin/open`, so the new Coral gets the login session's environment, not the run's HOME and data folder. On a person's own Mac it would start against the real data folder. Items 1 to 4 are safe anywhere and are what `--check-only` stops at.

With FROM equal to TO it is a dry run of the finding (item 3 expects "up to date", nothing staged).

## What ran now (macOS, this Mac, isolated, 2026-10-27)

1. `--from v2.0.0 --to v2.0.0`: items 1 to 3 PASS. v2.0.0's own updater reached GitHub and the Sigstore TUF mirror and said up to date (`trust: tuf`), relaunch refused as `nothing_staged`; its `coral-update status` is `feature on`, `apply_enabled true`, install `app`, writable.
2. `--from v1.4.168 --to v2.0.0` (the previous promoted release to the current one), run before the throwaway guard was added: items 1 to 4 PASS. 1.4.168's updater found v2.0.0, verified and staged it, offered the relaunch with its token, and refused an API key (403) and an agent's token (401). Then, for item 5, the person's request was accepted (202, the server stopped and the tray did not restart it), then nothing answered on the port within 300 s and the app was still 1.4.168. That is the `open(1)` environment above: the apply's restart cannot be shown from an isolated environment, and was not shown. It is **not** evidence that the apply fails; it is the reason items 5 to 8 need a throwaway machine. I could not see what the updater printed, so I do not know whether it rolled back.

Also seen: a check started by the tray's server failed twice with a `network` error in this environment (then backed off 5 minutes) while the same check run as `coral-update check` passed, and later runs of the same script passed; I could not reproduce a cause. If item 3 fails with `not_ready_reason: backoff`, wait for the backoff (the state file `updates/state.json` says when) and run again.

## Before the tag

Nothing here needs the tag; do not promote to test the updater (it would approve the release). After the release is promoted:

1. `tests/release/update_real.sh --from v2.0.0 --to v2.0.1 --check-only` on any Mac: finding, verification, staging, the refusals.
2. The whole script on a GitHub-hosted macOS runner (or a spare Mac with `--throwaway-machine`): the install and the restart with the tmux agent through it.
3. Linux (tarball): `tests/release/update_rehearsal.sh` runs the chain against a fake GitHub and Sigstore with the real server and the real apply (update, tampered, wrong version, unhealthy, crash, and the person's start), and `tests/release/upgrade_linux.sh OLD.tar.gz NEW.tar.gz VERSION` runs the apply's real steps on the two released tarballs. There is no real-GitHub Linux script yet: the same flow as `update_real.sh` with the tarball unpacked to a folder of its own and `coral` started directly would be the next piece (the updater restarts a Linux Coral from its run record, which a script's own start provides), run on epoch or a Linux runner, never on the operator's machine.
4. Windows is covered by `tests/release/upgrade_windows.ps1` on a runner (MSI; the apply needs the person's UAC).

## Known limits

- The updater never installs by itself: staging is automatic (five minutes after start, then every six hours), the install is the person's click. "Installs when idle" is the person's choice: the relaunch lists the agents that will restart and its acknowledgement token covers that list, so a changed list needs a new yes. a status read with a tmux agent running showed an empty list (the code adds the tmux agents only when the bundled tmux changed, `tmux_agents_restart`).
- A Homebrew install is never updated by the updater (`brew upgrade --cask coral`).
- A download of a release asset counts as a download of the release.
