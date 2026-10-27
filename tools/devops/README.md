# Landing and release scripts

The scripts the landing agent uses to assemble a `ci/<version>` batch, gate it, land it on `main` and publish the
release. They live here, not in a scratchpad, so a restarted session cannot lose a check (#4605). Every script stops on
the first failed check.

## The flow

1. **Assemble** the batch in a worktree on current `main`, from the approved patches, in the order given:

   ```bash
   git worktree add --detach /tmp/wt-v1491 origin/main
   tools/devops/apply-patches.sh /tmp/wt-v1491 p1491/*.patch
   ```

   Patches go in with `git am --3way --keep-cr`. Without `--keep-cr`, git strips the carriage returns that raw terminal
   captures need: v1.4.87 lost six PTY fixtures that way. Each patch is scanned for personal data and binaries first; set
   `CORAL_ALLOW_BINARY=1` for a patch whose binaries are known and reviewed. A conflict on the `test:cloud` line of
   `tests/frontend/package.json` is resolved as the union of both sides; any other conflict stops for a hand resolution.

2. **Pre-push**, the checks before the gate. `tools/devops/prepush.sh /tmp/wt-v1491` runs:
   - gofmt with the module's own toolchain;
   - build, plus vet with the default tags, `dev fts5` and `GOOS=windows`;
   - the route regenerators, which must leave no diff;
   - `go test ./...` on both tag sets (a light check on the Mac; the proof is the gate's go-tests, below);
   - `test:cloud`.

3. **Gate**: push the worktree to `ci/<version>` (that starts `cdp-gate`, `go-tests`, `go-race` and `gofmt`), then dispatch
   `windows-tests` on it:

   ```bash
   git -C /tmp/wt-v1491 push origin HEAD:refs/heads/ci/v1491
   gh workflow run windows-tests --ref ci/v1491
   ```

   The gate is green only when all eight cdp-gate jobs are green and the summary's first line says `green:`. The #4354
   end check must be quiet in every job. A flaky or failed suite's first failing line is printed under its name in the
   summary.

   **The Linux go test is `go-tests`** (GitHub, both tag sets, `internal/server/routes` and `pkg/tunnel` in shards of their
   own, about 6 minutes): since v1.4.106 it is the proof, where `tools/epoch-gate.sh` on the shared test host took about 60
   minutes of wall time on loaded days. It agreed with epoch twice (v1.4.104: routes rerun, v1.4.105: both tag sets in 19
   minutes). The epoch run is the fallback, for when GitHub is unavailable or a result needs a second machine:
   `EPOCH_HOST=epoch EPOCH_ROOT=/home/cknorow EPOCH_GO_ONLY=1 tools/epoch-gate.sh vNNN` from a clean worktree (go-only: epoch
   has no node or Chrome). `go-race` runs the race detector on the five high-risk packages per `ci/` push and on every
   package nightly. A FLAKY suite fails the gate: run it 10 times with no retries on the candidate and on `main`
   (`gh workflow run cdp-gate.yml --ref <ref> -f suites=<name> -f runs=10`); the same failure rate on both is a pre-existing
   flake, overridden and reported.

   After a green gate, refresh the suite durations the six parts are balanced by (#4605). The landed tree must be the
   gated tree, so the refreshed file is the first commit of the next batch (one `tests: suite_durations.json from the
   vX.Y.Z gate` commit, and only when the file changed), and that batch's gate runs with it:

   ```bash
   gh run download <cdp-gate run id> -D /tmp/gate-v1491
   (cd tests/frontend && node update_suite_durations.mjs /tmp/gate-v1491/cdp-{0,1,2,3,4,5}-a*/results.json)
   ```

   Do this after every release gate: it had not been run since v1.4.94, and by v1.4.101 the six parts took 233 to 369 s
   instead of about equal times (#4956). The parts are only as even as these numbers are fresh.

   `cdp-0` to `cdp-5` are the six parts (`cdp-6` the sequences and `cdp-7` the strict phase, which it ignores anyway).
   Only passing first attempts count, and suites missing from the run keep their old value.

4. **Notes and tag**:
   - Write the notes section in a file starting with `## vX.Y.Z — `, and add it on top of the gated head:
     `python3 tools/devops/insert-notes.py RELEASE_NOTES.md notes.md X.Y.Z`. Commit that file alone. `tools/devops/notes-commit.sh X.Y.Z notes.md <gated sha>`
     does both with the role identity and the `Gated-commit: <gated sha>` trailer that `release_provenance.py` reads.
   - **Known red suites (the operator's call, #8643, #8667):** when the operator has approved a known red cdp suite for this release, name it as the fourth
     argument: `tools/devops/notes-commit.sh X.Y.Z notes.md <gated sha> "strict: some_suite.test.mjs"` (1 to 3 suites, comma separated). The commit then also
     carries one `Accepted-red: <suite>, <suite>` line. The names are checked by `release_provenance.py`'s own parser before the commit is made, so a name
     it would refuse (more than three, a repeat, a character outside a plain suite name) stops the script. At the tag, provenance lets `cdp-gate` be red for exactly those
     suites and nothing else: each must really be red in cdp-gate's NEWEST push run on the gated commit (read from that run's `cdp-summary` artifact), every
     part must have reported, no suite may be flaky and the end checks and the stripped-dashboard job must be green; `go-tests` and `go-race` must still be green.
     A green rerun of the suite makes the waiver refuse, by design: re-check the run before tagging. The release record names the waived suites, the run and
     its attempt: open the run and read the summary before approving the `release` environment. Without the fourth argument nothing changes.
   - Land with `tools/devops/land-main.sh <old main> <notes commit> <gated tree>`. It checks that `main` is a
     fast-forward, that the parent's tree is the gated tree, and that the top commit is notes-only. It syncs the shared
     checkout's files with their modes, and stops if anyone else edited one of them.
   - Then `git tag vX.Y.Z <notes commit>` and push the tag. The release workflow builds, signs and publishes the release as a
     **pre-release that is not "latest"** (the AGENTIC channel, #5551): installed Corals, Homebrew and the stable download links keep
     serving the last APPROVED release until the operator runs the **Approve release** workflow (below).

5. **Finish**: `tools/devops/after-release.sh X.Y.Z` waits for the release run and runs `finish-release.sh` (the check is
   `verify-release.sh --stage agentic`: a plain tag is expected to be a pre-release, the tap is not expected to have moved).
   `finish-release.sh X.Y.Z` itself:
   - sets the release body from the tag's notes;
   - starts the runtime check;
   - runs `tools/verify-release.sh`, which takes every file from the release run's artifacts and checks each against
     GitHub's digest of the published asset, so it verifies the published files without downloading them. It also checks
     that the tap's `Casks/coral.rb` carries the DMG's sha256 from `SHA256SUMS.txt` at `--stage approved` (and the repo's own, once
     it is at this version). It needs the PINNED cosign on PATH (#5112): `after-release.sh` and `finish-release.sh` stop at once without it, and
     `verify-release.sh --require-cosign` (which `finish-release.sh` passes) makes a missing cosign, or a release with no
     bundle to check, a FAIL row instead of a SKIP. Install it with `tools/devops/install-cosign.sh [DIR]` (default
     `~/.local/bin`; put DIR on PATH): it takes cosign's release binary and installs it only when its sha256 equals the line in
     `tools/devops/cosign.sha256`, which is the anchor in this repo, changed only by a reviewed commit (with `COSIGN_VERSION` in
     the script). A cosign that is not that exact binary (a distro build) is refused: it is the tool that vouches for every release.

   Edit the body only after verify-release has passed, since its notes row compares the body with the tag's notes.

6. **Approval and cask (the operator's act, #5551)**: the operator runs *Actions > Approve release > Run workflow* with the tag
   (no agent ever dispatches it, revokes, or edits the Latest mark). Three jobs, one per privilege: `verify` (read only: the
   release is published, immutable, a pre-release, on `main`, newer than the current latest, not revoked, and
   `verify-release.sh --stage agentic` passes), `flip` (`contents: write`: `tools/devops/approve-release.sh flip` clears the
   pre-release flag, marks it latest and appends a display-only `Approved: <UTC RFC3339>` line to the body (the last line; the actor is in the run summary)), `tap`
   (environment `approve`, the tap deploy key only: `tools/devops/update-tap.sh` moves the cask by a new commit). `mode=revoke` is
   the only way back: it re-marks the previous release latest (GitHub does not move the mark by itself), puts the cask back by a new
   commit and writes a `Revoked:` line that makes the tag unapprovable for ever. After an approval:
   `tools/verify-release.sh vX.Y.Z --require-cosign` (default `--stage approved`), then `tools/devops/cask.sh X.Y.Z` makes the one
   `cask: Coral X.Y.Z` commit on `main` (it reads the DMG's sha256 from the release's metadata, not by downloading anything).
   `tools/devops/release-cadence.sh` prints every release with its channel and how long it has waited.

## Runbook: approving, revoking and the hand fallbacks (#5551, #5559)

- **First approval (144)**: done with the operator watching. The `flip` job reads the result back and fails loudly if the labels did not move.
- **Hand fallback for an approval** (the operator, in a terminal or the browser): `gh release edit vX.Y.Z --prerelease=false --latest`. The tap stays on the old cask
  (the safe side: `brew` keeps the previous version) until it is moved by hand from the signed `SHA256SUMS.txt` of that release.
- **Hand fallback for a revoke**: `revoke` edits the tag first and then re-marks the fallback; if the second edit fails the read-back fails and the fallback must be marked by hand:
  `gh release edit vX.Y.Z --prerelease --latest=false` for the revoked tag, then `gh release edit vPREVIOUS --latest` for the highest earlier approved release (GitHub does not move
  the Latest mark by itself). A revoke is allowed only for the release that IS latest (approval is monotonic, so the fallback is always the right one).
- **Artifact retention**: the `tap` job takes the cask's sha256 from the `release-sums` artifact of the release run (the checksums as signed, no download). GitHub keeps run artifacts at
  most 90 days (the repository setting is already at that maximum, and `release.yml` says so explicitly). Approving, or reverting to, a release older than that fails in the `tap` job
  AFTER `flip`: the labels moved, the cask did not. Do not let a release wait 90 days.
- **The record**: the `Approved:` and `Revoked:` lines are in the release body, which anyone who can edit releases can change: they are a record and a guard against a mistaken
  re-approval, not a security control. Every Monday read the audit log for Approve release runs and their actors (`gh run list --workflow approve-release.yml`): the team rule is
  that no agent dispatches it.

## The pre-tag dry run (#8642, Goal #65)

The step before every tag. `.github/workflows/release-dryrun.yml` runs release.yml's `resolve` job on a candidate commit without tagging anything: the release
provenance record (who, which commit, on `main`, and whether go-tests, go-race and cdp-gate passed on exactly that code) and every release self-test of that step
(the list is kept equal to release.yml's by `tests/release/release_dryrun_test.py`). It runs every check to its end and prints one line, `GO`, or `NO-GO` with the
failing line of each check (also in the run's step summary). It builds, signs and publishes nothing and its token is read-only (and only the provenance step gets it: the candidate's own test scripts never see it). GO is advisory: the real gate stays release.yml and the operator's approval.

```bash
gh workflow run release-dryrun.yml --ref main      # the candidate is the commit the run starts on
gh run list --workflow release-dryrun.yml --limit 1 --json databaseId,status,conclusion
gh run view <id> --log | grep -E '^(GO|NO-GO|FAIL)'   # poll the run, then read it; gh run watch hangs a session
```

Post `GO` (with the run id and the commit) or the failing lines on the board before the release approval is asked for. To try a change to the workflow itself, push a
branch named `dryrun/<anything>`: the same job runs on a push there.

## Release provenance (#5550)

- **At every tag**: the first step of `release.yml`'s resolve job runs `tests/release/release_provenance.py`. It writes into the run's
  summary who pushed the tag, the tagged commit, whether that commit is the tip of `main` (or on it), and whether `go-tests`, `go-race` and
  `cdp-gate` (`.github/gate.json`, "always") passed on that exact code. The heavy gates run on the commit pushed to a `ci/` branch; the tagged
  commit is that tree plus the release notes, so a notes-only tagged commit is judged by its single parent's runs. A failed, cancelled or
  missing gate fails the release before anything is built.
  Every tag runs it: push the commit to a `ci/` branch and let the gates pass first.
- **Every Monday** (`reverify-releases.yml`, also by hand from `main`): the three newest published releases are verified again
  with `verify-release.sh --require-cosign` (stage by their state), from the release runs' artifacts, no download from the release. A release
  that changed after publication, or whose signatures stop verifying, turns the run red. The macOS-only rows (DMG signature, stapling) SKIP on
  the Linux runner; they are the smoke's job.

## Downloads from a release by our own automation

A download of a release asset counts in the release's download numbers, so our own checks don't download them (#4936).
They read the same bytes from the release run's artifacts (`release.yml` keeps every package, plus `release-sums`
with `SHA256SUMS.txt` and the Sigstore bundles), and prove those bytes are the published ones with GitHub's digest of
each asset, which is release metadata, not a download.

Expected downloads by our automation per release: **none**.

| Step | Reads | Downloads from the release |
|---|---|---|
| `approve-release.yml` tap job | `release-sums` artifact of the release run | none |
| Runtime check (`standard-runtime-verify.yml`) | `coral-linux-<arch>` artifacts of the release run | none |
| `tools/verify-release.sh` (default) | the release run's artifacts, and the previous release's run for the entry counts | none |
| `tools/devops/cask.sh` | the DMG's digest from the release metadata | none |

What still downloads, and when:

- `tools/verify-release.sh` on a release made before #4936, whose run has no `release-sums` artifact: `SHA256SUMS.txt`
  and the three Sigstore bundles (4 small files, no packages).
- `tools/verify-release.sh --published` and `tools/devops/download-release.sh`: every asset (9 files), plus, with
  `--published`, the previous release's two Linux tarballs and portable zip. Only when someone runs them on purpose, to
  check exactly what a user gets, or after the run's artifacts have expired.
- `windows-runner-dryrun.yml`: one portable zip of the version it is given, on a manual run or a `ci/` push that
  changes `tests/release/smoke_windows.ps1` or the workflow.

If a release run's artifacts have expired, the runtime check and verify-release fail with a message that says so; they
don't fall back to downloading.

Our own runs also send no usage events. Every CI workflow that builds or runs Coral, and every test runner and epoch
script, sets `CORAL_TELEMETRY_DISABLED=1`. CI's own builds carry no PostHog key anyway; only `release.yml` and
`installers/build-macos.sh` put one in.

## Rules these encode

- Test servers and test runs never use `~/.coral` or a running Coral. `CORAL_CLOUD_URL` is unset, and go test runs in
  a short `/tmp` dir, because a long TMPDIR breaks tmux socket paths.
- The landing identity is set per command (`CORAL_LAND_NAME` and `CORAL_LAND_EMAIL`, by default "Coral DevOps
  stack"). The global git identity is never used.
- Stage by explicit path, never amend or rebase `main`, and remove temp folders by exact path.

## The landing rule is the release rule (#8645, Goal #65)

A batch lands on `main` by the same test a release is tagged by. Two parts, both required:

1. **Go checks green.** `go-tests` (both tag sets), `go-race`, `gofmt` and the cross-build on the candidate's `ci/<version>` branch; `windows-tests` too when the batch touches `_windows.go` or a Windows test. Every job, not the suite count (the summary's first line says `green:` only when all of them are).
2. **The full `cdp-gate` is no worse than `main`.** The suites that FAILED or timed out on the candidate must be a subset of those that failed on `main`'s latest daily baseline (below), and the end-check count must be 0. A suite that is green on the baseline and FAILED or timed out on the candidate blocks the landing: the batch is not pushed until that suite is green again or the commit that broke it is taken out. A suite that failed on both is not a new red and does not block; it keeps its owner and task (next section). **A FLAKY suite (red on the first attempt, green on the retry) does not block by itself**: some flake on `main` too, and one that merely hits on a candidate's first attempt would block every landing. It blocks only when a repeat of it (`gh workflow run cdp-gate.yml --ref <ci branch> -f suites=<suite> -f runs=10`, and the same on `main`) shows a worse pass rate on the candidate than on `main`. The same comparison holds for `windows-tests`: its reds on the candidate are compared with the latest `windows-tests` run on `main`, and a Windows-only red that `main` already has under an owned task is not new. A red that is explicitly accepted for a release is the existing `Accepted-red` trailer on the notes commit (#8643), approved by the Orchestrator, and never a reason to land a batch.

To compare: read the candidate's `cdp-summary` artifact (`cdp-summary-a<attempt>`, the `failed` and `flaky` lists in `cdp-summary.json`) and the baseline's the same way:

```bash
gh run download <candidate-run-id> -n cdp-summary-a1 -D "$(mktemp -d /tmp/cdp-cand.XXXX)"
gh run download <baseline-run-id>  -n cdp-summary-a1 -D "$(mktemp -d /tmp/cdp-base.XXXX)"
```

The new reds are `failed` of the candidate minus `failed` of the baseline (`flaky` is listed, not subtracted). `ends` (the count of end-check failures) must be 0 on the candidate whatever the baseline says. Post the list with the verdict (`no worse than main` or `blocked by: <suites>`), and the FLAKY suites with their repeat result, before pushing `main`.

### A new red has an owner and a task the same day

- The landing agent names the suites of the new-red set on the board the moment the gate finishes, with the failing line the summary prints under each suite's name, and its proposed owner.
- The owner is the author of the commit in the batch that changed what the suite drives (a grep of the suite's ids and routes over the batch's diff; the batch order says which commit it is). When that is not clear, the Orchestrator names the owner within the same day.
- Only the Orchestrator and the Operator create shared tasks, so the landing agent asks the Orchestrator in the same post to create it the same day, assigned at creation (`coral-board task add "<suite>: red on <sha>" --assignee "<owner>" --goal 65`; creating it and then reassigning broadcasts "tasks available"). A flake that the repeat shows is worse than on `main` gets the same task; the repeat (about 20 runs on the candidate and on `main` when it must name a commit) comes before anyone is blamed.
- A red already on `main` with no open task is named in the next daily post for the Orchestrator to give a task; a red whose task is more than a day old is listed again in that post.

### A daily full cdp-gate on `main`

Once a day (the same time each day, off the top of the hour) the landing agent dispatches the gate on `main` and posts the result to the board:

```bash
gh workflow run cdp-gate.yml --ref main
gh run list --workflow cdp-gate.yml --branch main --limit 1 --json databaseId,status,conclusion
gh run view <id> --json status,conclusion   # poll this every few minutes until status is completed; gh run watch hangs a session
# then download the cdp-summary artifact as above
```

The post is one summary line (`green: N/N` or `NOT green: ...`, copied from the run's summary), then a numbered list: each red suite, its first failing line, its owner and its task (or `no task: asking the Orchestrator`), and the new reds since the previous daily run. The run's id is the next day's baseline: keep it in the post, so the comparison above always names a run. Before the first daily run, the baseline is the latest completed `cdp-gate` run on `main` that `gh run list --workflow cdp-gate.yml --branch main` finds (and the latest `windows-tests` run on `main` for the Windows comparison). Two reds in a row on the same suite with no task is a failure of this rule, and the Orchestrator is told.

The dispatch runs on GitHub's runners with no secrets and read-only contents, as every `cdp-gate` run does (the file's header says why); the posting is the landing agent's own `coral-board post --file`, since the Coral board is not reachable from a workflow.

## No programs and no big files (#5444)

A built program carries the build machine's paths and account name, so one committed by mistake is a leak in a public repository. `tools/devops/check_binaries.py BASE TIP` refuses a range in which any commit (each on its own) adds or changes a file over 5 MB or one that starts with an ELF, Mach-O or PE header, except the paths in `tools/devops/binary-allowlist.txt` (icons today). `apply-patches.sh` runs it after each patch, `land-main.sh` before it pushes, `prepush.sh` before a gate, and `install-pre-push-hook.sh` installs `pre-push-hook.sh` as the shared git hook so that any worktree's `git push` is checked (`--no-verify` skips it, as for any hook). Tests: `tests/release/check_binaries_test.sh`, `tests/release/pre_push_hook_test.sh`.

## The Download section of a release's notes (#5467)

GitHub hides the disk image behind "Show more assets", so every release's body starts with a Download section: direct links to that tag's stable-name files and the Homebrew line. `finish-release.sh` builds it with `tools/devops/download-section.sh VER` (the links name the release home of `tools/release-homes.txt`, so they follow a repository move), checks each link with a HEAD request (a HEAD is not a download) and puts it above the tag's notes when it sets the body; `RELEASE_NOTES.md` is unchanged. Releases before 1.4.130 have no stable names and get the notes alone. Test: `tests/release/download_section_test.sh`.


## Promoting a release (#6274, #6394)

Only the release owner dispatches `promote.yml` (Actions > Promote release), after the release is approved. Each promotion is its own release, `promote-<tag>-<sequence>`: a pre-release that is never Latest and holds only `promote.json` and its Sigstore bundle. Nothing is replaced: promoting a tag again (to revoke) makes a new release with a higher sequence.

**Approve the `release-promote` run within about a minute of entering the code:** the code is checked only after the reviewer approves, and it lasts about a minute, so a slow approval fails on an expired code (run it again with a fresh code). The window is not widened.

If the run fails after it created the release (the step "Publish the promotion as its own release" says where), a **draft** named `promote-<tag>-<sequence>` is left under Releases. A draft is not published and the client never reads it: delete the draft (Releases, the draft, Delete), then dispatch the promotion again. A published promotion is never deleted or edited.

A rehearsal is a promotion of a release that is still a pre-release: the manifest says `prerelease: true`, the whole publish path runs, and every client refuses it. **Rehearse a tag only BEFORE its real promotion, never after:** the client takes the highest sequence among a tag's promotions, so a rehearsal made after a real promotion would carry the higher sequence and be refused, which withholds the update until a higher real promotion is made.
