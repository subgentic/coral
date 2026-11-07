# Quickstart

Get from a downloaded release to a committed, tested change.

The example output and timings in steps 4-5 are illustrative: they come from a test run of a small task, and your agent CLI's wording and speed will differ. Where something is unverified, it says so.

> **Example result:** a small task took about 90 seconds from starting Coral to a
> committed, passing change — *after* your agent CLI was installed and signed in, and
> *after* the trust prompt in step 4 was answered. Installing and signing in to an agent
> CLI is the long pole on a clean machine, and Coral does not do it for you.

## Prerequisites

| Requirement | Notes |
|---|---|
| **tmux** | Not needed. Agents run in Coral's built-in terminal (pty) by default on every system. tmux is needed only if you choose it (Settings > Terminal, or `--backend tmux`) to keep agents running after Coral quits; the macOS app bundles tmux 3.7c, and elsewhere you install it first. See [Platform support](#platform-support). |
| **git** | Worktree and branch features need a real repository. |
| **An agent CLI** | At least one of `claude`, `codex`, `agy` (Antigravity), or `pi` — **installed and authenticated**. Coral drives these tools; it does not install, configure, or authenticate them. |

Coral supports exactly four agent CLIs:

| Agent | Binary | Install and sign in |
|---|---|---|
| Claude Code | `claude` | [Claude Code documentation](https://code.claude.com/docs/en/overview) |
| Codex | `codex` | [openai/codex](https://github.com/openai/codex) |
| Antigravity CLI | `agy` | [antigravity.google](https://antigravity.google), or `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| Pi.dev | `pi` | [pi.dev](https://pi.dev) |

Follow each vendor's current instructions; install commands change and Coral does not
maintain them. Where a CLI is missing, Coral's prerequisite check and the Launch dialog link to
these official pages (and show the one-line command where the vendor has one).

The Antigravity installer puts `agy` in `~/.local/bin`. Coral looks there itself, so it finds `agy`
even when that folder is not on your `PATH`. To run `agy` in your own terminal, add
`export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` or `~/.bashrc` and open a new terminal. A custom executable can be set per agent type in **Settings > Agents > CLI paths** (a closed section; empty uses your `PATH`), which is the `cli_path_<type>`
setting. Coral launches only the agent CLIs listed above; adding another one needs a code change and a rebuild.

> **If you ever ran `pip install agent-coral`, remove it first.**
> The retired Python package installs binaries with the *same names* as this one
> (`coral`, `coral-board`, `launch-coral`, the hooks), uses the same `~/.coral`
> directory, the same `sessions.db` / `messageboard.db` filenames, and the same port
> 8420. On a default `PATH`, pip's `~/.local/bin` wins, so typing `coral` can silently
> start the old Python server and look like it worked.
>
> ```bash
> which -a coral coral-board launch-coral   # inspect multiple hits for an old Python install
> pip uninstall agent-coral
> ```

## Platform support

| Platform | Status |
|---|---|
| **macOS** | Signed and notarized universal app ([`Coral.dmg`](https://github.com/subgentic/coral/releases/latest/download/Coral.dmg), Apple Silicon and Intel, macOS 13 minimum) with bundled tmux. The macOS 13 minimum is checked in the binaries but has not been run on a macOS 13 host. |
| **Windows** | [`Coral-x64.msi`](https://github.com/subgentic/coral/releases/latest/download/Coral-x64.msi) (installer) or [`Coral-x64-portable.zip`](https://github.com/subgentic/coral/releases/latest/download/Coral-x64-portable.zip), x64. Not code-signed (SmartScreen warns of an unknown publisher; verify the download as the README shows). Agents run with the native pty backend (no tmux); the default port is 8450. |
| **Linux** | [`coral-linux-amd64.tar.gz`](https://github.com/subgentic/coral/releases/latest/download/coral-linux-amd64.tar.gz) (x86-64) or [`coral-linux-arm64.tar.gz`](https://github.com/subgentic/coral/releases/latest/download/coral-linux-arm64.tar.gz) (ARM64), statically linked. CLI/server only — no tray or desktop app. Agents run in the built-in terminal; tmux is not bundled and is needed only if you choose it. |
| **Homebrew** | `brew install --cask cdknorow/coral/coral` installs the release's macOS app; the release workflow updates the tap with each release's checksum. |

## 1. Install

On **macOS** and **Linux**, you can install the latest verified release with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/subgentic/coral/main/install.sh | bash
```

What `install.sh` does:
- Downloads the latest release package for your OS and CPU over HTTPS and checks it against `SHA256SUMS.txt` (and verifies the Sigstore signature when `cosign` is installed; pass `-s -- --require-signature` after `bash` to stop the install unless `cosign` verifies it).
- On **macOS**, verifies that `Coral.app` is signed and notarized, installs `Coral.app` in `~/Applications` (without `sudo`), and links the command-line tools into `~/.local/bin`.
- On **Linux**, unpacks Coral's programs (`coral`, `coral-board`, `coral-agent`, `launch-coral`, `coral-update`, and the hooks) into `~/.local/bin`.
- Pass `-s -- --dry-run` after `bash` to see what would be downloaded and installed without changing anything.

Or download directly from [GitHub Releases](https://github.com/subgentic/coral/releases/latest). The stable
names always point to the newest release: `Coral.dmg`, `Coral-x64.msi`, `Coral-x64-portable.zip`,
`coral-linux-amd64.tar.gz` and `coral-linux-arm64.tar.gz`. Each release also keeps versioned names
(`Coral.v<version>.dmg`, `coral-linux-<arch>-<version>.tar.gz`, `Coral-<version>-x64.msi`,
`Coral-<version>-x64-portable.zip`): the same files.

- **macOS (`Coral.dmg`):** Open the `.dmg` and drag `Coral.app` to `Applications`. Agents that Coral launches can run Coral's own command-line tools without you changing PATH.
  - *Optional — use `coral` from your own terminal:* Run `/Applications/Coral.app/Contents/MacOS/install-cli.sh` to symlink the CLI tools into `~/.local/bin`, and add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` or `~/.bashrc`.
- **Windows (`Coral-x64.msi`):** Run the MSI installer, which installs Coral to `Program Files\Coral`, adds it to your `PATH`, creates a **Coral** Start Menu shortcut, and offers to launch Coral when setup finishes.
- **Linux (`coral-linux-amd64.tar.gz` or `coral-linux-arm64.tar.gz`):** Extract the binaries into `~/.local/bin`:
  ```console
  $ uname -m        # x86_64 → the amd64 tarball, aarch64 → the arm64 tarball
  $ mkdir -p "$HOME/.local/bin" && tar xzf coral-linux-amd64.tar.gz -C "$HOME/.local/bin"
  ```

## 2. Open Coral

- **macOS:** Open **Coral** from `Applications` (or `~/Applications`). Coral starts its menu-bar tray icon and opens the native Coral window.
- **Windows:** Open **Coral** from the Start menu (or leave **Launch Coral** checked at the end of the MSI installer).
- **Linux:** Run `~/.local/bin/coral`, which starts the server and opens the dashboard in your default browser at `http://localhost:8420`.

On first launch, review the Terms of Service and accept them if you agree, then set a password when **Protect Coral with a password** appears.

*Optional — starting the server from a terminal:*

```console
$ coral --host 127.0.0.1 --port 8420 --no-browser
Coral dashboard: http://localhost:8420
Press Ctrl+C to stop
```

Useful flags: `--home <dir>` (data directory, default `~/.coral`, also `CORAL_DATA_DIR`), `--port` (default
8420 on macOS/Linux, 8450 on Windows), `--host` (one address or a comma list, see [below](#listening-on-a-tailnet-address)),
`--backend pty|tmux`, `--no-browser`. Coral listens on `127.0.0.1` unless
[remote access](#remote-access) is enabled and restarted.

`coral --version`, `coral -v`, and `coral version` print the version and exit without
starting a server. A running server's version is in its startup log and `/api/system/status`.

### Running a second instance

If you already have a Coral running, isolate the second one with `--home` **and** a
different port, and keep the path short:

```bash
coral --home /tmp/coral-t1 --port 8452 --no-browser
```

> **What isolation covers.** A non-default `--home` gets its own tmux socket
> (`<home>/tmux.sock`), and session discovery no longer merges tmux's default socket
> for it, so a second instance
> does not list the first instance's agents. `CORAL_TMUX_FALLBACK=1` re-enables the
> merge. Agents receive `CORAL_URL`, `CORAL_PORT`, `CORAL_HOST` and `CORAL_DATA_DIR`,
> and `coral-board` keeps its state under `CORAL_DATA_DIR`,
> so the board follows a non-default data directory and port.
>
> A tmux socket path over about 104 characters (macOS) cannot bind, so keep the
> directory short. If you are unsure what a new instance can see, check:
> ```bash
> # a script you run yourself, never an agent
> curl -s -H "Authorization: Bearer $(coral api-key --home /tmp/coral-t1)" localhost:8452/api/sessions/live   # sessions you did not create = not isolated
> ```

## Remote access

Remote (LAN/mobile) access is **off by default**. Enabling it in Settings saves a preference and
takes effect only after Coral restarts. `--remote` enables it for one run without saving it.
The dashboard reports the saved and effective state separately. Details: `PRIVACY_CONTROLS.md` and `/api/system/privacy`.

### Listening on a tailnet address

To reach Coral from your other devices on a tailnet (Tailscale) without a proxy, listen on
loopback **and** the tailnet address, with remote access on, and sign in with your Coral
password or API key:

```console
$ coral --remote --host 127.0.0.1,100.101.102.103
```

`--host` (or `CORAL_HOST`) takes a comma list; Coral opens one listener per address, all on
one port. Requests to the tailnet address need the API key or a dashboard sign-in, like any
remote caller. If the list names only network addresses (`--host 100.101.102.103`), Coral
also listens on `127.0.0.1` and says so in the startup log, so this computer's agents, the
command line and the dashboard keep using loopback; `--no-auto-loopback` (or
`CORAL_NO_AUTO_LOOPBACK=1`) turns that off. Agents always get the loopback address in
`CORAL_URL` when Coral listens on one. With remote access off, Coral listens on
`127.0.0.1` only, whatever `--host` says (a list of only loopback addresses is kept).

Whichever address a request arrives on, what it may do depends on where it comes from, never
on the listener: a program on this computer reaching the loopback listener is local, and anyone
reaching the tailnet address needs a dashboard sign-in or API key. A local request must also name this server in its
`Host` header (`localhost`, a loopback address, or an address in `--host`); any other name or
IP is refused as a DNS-rebinding attempt, unless Coral listens on every interface.

A hostname in the list is listened on at the first address it resolves to: `localhost`
counts as loopback, any other name (`myhost.local`) as a network address. Every interface
(`0.0.0.0`, `::`) can't be combined with other addresses, since it already includes them:
Coral stops at startup and says so.

> **On a computer other people log in to:** a loopback listener lets any local user reach
> Coral, but [strict local auth](auth.md#strict-local-auth-the-default) (the default) makes every request from
> this computer need an agent's session token, the dashboard sign-in, the command line's
> signature or the API key, which your agents and the `coral` command already send. Keep it
> on (don't start Coral with `--strict-local-auth=false`) and keep the loopback listener.
> `--no-auto-loopback` is not the stricter setup where Coral runs agents: they would reach it
> through the network address, where only the API key or a dashboard sign-in is accepted, and
> their board and task calls would be refused. Use it only on a computer where Coral runs no
> agents (Coral logs a warning when it starts that way).

### Remote access securely

Remote access on its own is **plain HTTP**: the API key, the login cookie and everything
typed into agent terminals cross the network unencrypted, readable by anyone on it. The
first-launch question, the startup log (`[startup] WARNING: remote access is on over plain
HTTP …`) and **Settings > Network and Hub > Remote access** all say so. Pick one of:

- **Coral Hub** (recommended away from home): the server connects out to Coral Hub over
  TLS; nothing listens on the network. See [hub.md](hub.md#connecting-a-server-to-coral-hub).
- **A TLS reverse proxy** on the same computer (Caddy, nginx, Tailscale Serve…) in front of
  `http://127.0.0.1:8420`, with remote access left **off** so Coral itself listens on
  loopback only. Forward WebSocket upgrades (`/ws/…`), and send
  `X-Forwarded-Proto: https`.

  Keep [strict local auth](auth.md#strict-local-auth-the-default) on (the default), so
  requests need credentials even on loopback. Have the proxy preserve forwarding
  headers: a forwarded request is a remote caller and needs a dashboard sign-in or API
  key. A proxy that strips those headers looks direct. **`require_auth_on_loopback`**
  (Settings; Operator-only) requires credentials for loopback requests, even if strict
  local auth is disabled; see [authentication](auth.md). Do not disable authentication
  to make a proxy work.

- **Native TLS**: `coral --tls-cert cert.pem --tls-key key.pem` (or `CORAL_TLS_CERT` and
  `CORAL_TLS_KEY`), PEM files, with remote access on. The same port then serves HTTPS, and
  WSS for the terminal and live feeds (the dashboard picks `wss:` on an `https:` page). From
  other computers only HTTPS is accepted: a plain `GET` is redirected to `https://`, any other
  plain request gets `400`. Plain `http://localhost` keeps working on this computer, so
  `coral-board`, the hooks and agents need no change. Giving only one of the two files, or a
  pair that does not load, stops Coral at startup. The mobile QR code uses `https://`. A
  self-signed certificate works, but each device must trust it; `mkcert` makes a local CA.
  For example:

  ```console
  $ coral --remote --tls-cert ~/certs/coral.pem --tls-key ~/certs/coral-key.pem
  Coral dashboard: https://localhost:8420 (TLS; plain http:// only from this computer)
  ```

## 3. Open the dashboard

Open the address printed at startup (normally **http://localhost:8420**). If the
browser shows **Create a password**, enter and confirm a password, then choose
**Create password and open Coral**. Later, sign in with that password. The desktop
app can open a signed-in browser directly; `coral open` does the same from your own
terminal on the server. For a second instance, pass its `--home` and `--url` to
`coral open` too.

Coral Hub (app.coralhub.dev, invite-only beta) is optional. A fresh install stays local
until you choose to connect from Home or **Settings > Network and Hub**, or run
`coral cloud connect`. In the connect flow, approve the link/code and choose the
hub's access (View, Interact or Launch). See [connecting to Coral Hub](hub.md#connecting-a-server-to-coral-hub).

The first-launch offer appears only when you explicitly give a Hub URL
(`--cloud-url https://app.coralhub.dev` or `CORAL_CLOUD_URL`) or request it with
`--cloud-connect prompt` (`CORAL_CLOUD_CONNECT=prompt`). `--cloud-connect auto`
also offers the dashboard screen, but only logs the terminal link/code instead of
asking a terminal question. The release build's default
URL alone does not trigger the offer. `--cloud-connect off` suppresses it;
`--cloud-url off` disables Hub connections. Nothing is sent to the Hub until you connect.

## 4. Launch your first agent

Home asks **What do you want to work on?** with **New agent**, **New team** and **New goal** (elsewhere, **+ New agent**; **Open folder** is in the **+ New** chooser and a computer's menu). Choose **New agent**, enter an existing
project folder on the computer running Coral and choose **Next**. Step 2 is the
persona (optional); step 3 has the **Agent** tab, where you choose your installed
CLI, then choose **Launch** (it is available from every step once a folder is set). In **Chat**, type a task and press Enter
to send it; check **Terminal** first for any sign-in or trust prompt. An agent that is waiting for you (a prompt, a question) is listed under **Inbox > Needs you**. The equivalent API call (with [strict local auth](auth.md#strict-local-auth-the-default), the default, add
`-H "Authorization: Bearer $(coral api-key)"` to every `curl` in this guide; the key is for a script you run yourself, never an agent):

```console
# a script you run yourself, never an agent
$ curl -H "Authorization: Bearer $(coral api-key)" -s -X POST http://127.0.0.1:8420/api/sessions/launch \
    -H "Content-Type: application/json" \
    -d '{"working_dir":"/path/to/repo","agent_type":"claude",
         "display_name":"first-agent","prompt":"...your task..."}'
{"launch_path":"pty","ok":true,"terminal":"tmux",
 "session_id":"3ea283fc-...","session_name":"claude-3ea283fc-..."}
```

> `terminal` reports what the session actually runs on (`tmux` or `pty`). `launch_path`
> names the launch path ("through the terminal backend") and reads `pty` even for tmux
> sessions, so use `terminal` (or `tmux_session` in `/api/sessions/live`). Other fields
> are omitted above.

### Or start a team

Choose **New team** on Home. In Step 1, name the team and choose the folder it works in. In Step 2, start from the **Default team (3 members)** template (an Orchestrator, a Lead Developer and a QA Engineer, already in **Members** and each removable), click **Describe your team** to generate a roster, or launch an Orchestrator on its own and tell it in **Chat** what teammates and goal you want. The Orchestrator's built-in `orchestrator-team-builder` skill writes a `team-plan.md` artifact and puts an approval card in **Inbox > Needs you**; once you click **Approve**, the Orchestrator launches the teammates via `coral-agent launch`, creates the goal and tasks, and delegates reviews; see [Teams](teams.md).

### If your first agent is waiting for input

On its first run in a directory, the agent CLI may ask its own trust question. An
earlier Claude screen looked like this (wording and choices vary by CLI version):

```
Quick safety check: Is this a project you created or one you trust?
❯ No, exit
  Yes, I trust this folder
Enter to confirm · Esc to cancel
```

The agent can look alive and idle while it waits. Open **Terminal** in the dashboard
(or check **Inbox > Needs you**), read the current prompt and answer it (or toggle **Trust this folder** in Step 1 of **New team** before launching). Coral detects known startup prompts, but this
has not been verified for every provider/version. Codex can also ask you to review
Coral's hooks before it starts; read that request in Terminal.

Note that `/api/sessions/live/$NAME/keys` refuses API-key (`Authorization: Bearer`) calls while a startup trust prompt or permission dialog is open (`"nothing was typed: a prompt is open"`), because only the person at the computer (via the dashboard or a signed-in browser cookie from `coral open` / `login_token`) may answer a prompt. For ordinary terminal input in a script you run yourself when no prompt is open, the keys API accepts named keys:

```bash
# a script you run yourself, never an agent
# NAME and SID are the agent's "name" and "session_id" from GET /api/sessions/live.
# Note: requires a signed-in dashboard session cookie when answering a startup/permission prompt.
curl -H "Authorization: Bearer $(coral api-key)" -s -X POST "http://127.0.0.1:8420/api/sessions/live/$NAME/keys" \
  -H "Content-Type: application/json" \
  -d "{\"keys\":[\"Down\"],\"agent_type\":\"claude\",\"session_id\":\"$SID\"}"
curl -H "Authorization: Bearer $(coral api-key)" -s -X POST "http://127.0.0.1:8420/api/sessions/live/$NAME/keys" \
  -H "Content-Type: application/json" \
  -d "{\"keys\":[\"Enter\"],\"agent_type\":\"claude\",\"session_id\":\"$SID\"}"
```

The CLI may remember your answer for that repository. Coral does not answer these
startup trust or hook-review questions for you.

## 5. First review and artifact

In a team run, workers submit completed tasks for review and attach verification artifacts:

1. **Submit for review:** When the developer finishes implementing and testing a task, it runs `coral-board task submit-review <id>`.
2. **Delegate and verify:** The Orchestrator delegates the review with `coral-board task review <id> --to "<Reviewer>"` (or Coral auto-delegates when `default_reviewers` is set). The reviewer claims the review task, runs the test suite independently, uploads a review report with `coral-agent artifact upload <file>` (which returns an immutable `coral://artifacts/<sha256>` URI visible in the **Artifacts** tab and, when tagged `--tag "for review"`, in **Inbox > Needs you**), and runs `coral-board task approve <id> --round 1`.
3. **Completion:** The last reviewer's approval automatically marks the task **completed** on the board.

Given our `stringutil` Go package and this task —

> Add a function `Capitalize(s string) string` to `stringutil.go`. Then create
> `stringutil_test.go` with table-driven tests for **both** `Reverse` and `Capitalize`.
> Run `go test ./...` and make sure it passes.

— the result of that walkthrough on `v2.0.59`, after `Dev` implemented `Capitalize` and `Reviewer` verified and approved round 1:

```console
$ gofmt -l . && go vet ./... && go test ./... -v -count=1
=== RUN   TestReverse
--- PASS: TestReverse (0.00s)
=== RUN   TestCapitalize
--- PASS: TestCapitalize (0.00s)
PASS
ok  	example.com/stringutil	0.145s
```

Sixteen subtests (6 for `Reverse`, 10 for `Capitalize`, including multi-byte UTF-8 and invalid UTF-8), verified independently by `Reviewer` and recorded in `review-task1-round1.md`.

## Where a first run actually goes wrong

| Symptom | Cause |
|---|---|
| Agent launched, no output, looks hung | A trust, hook-review or sign-in prompt may be waiting. Open **Inbox > Needs you** or **Terminal** and read it; a launched process alone does not prove provider access. |
| Teammates launched by Orchestrator sit waiting before their first post | Agents launched via `coral-agent launch` start ask-first (`default`) unless the person sets otherwise. Approve their first command in **Inbox > Needs you** or **Terminal** (or choose Claude's `Yes, and switch to auto mode`). |
| Board nudges pause after you type in an agent's Terminal | Typing in an agent's terminal activates a 60-second `TypingHold` so Coral does not interrupt you mid-command. After 60 seconds without keystrokes, Coral flushes `[Coral] While you were talking: ...`. |
| `coral: command not found` in your own terminal after a DMG install | Agents launched by Coral get the CLI tools automatically, but your own shell needs `/Applications/Coral.app/Contents/MacOS/install-cli.sh` and `~/.local/bin` on `PATH` (or install via `install.sh`). |
| `coral` starts something unfamiliar | The retired `agent-coral` pip package is shadowing it. Run `which -a coral` and `pip uninstall agent-coral`. |
| Agents launch but never post to the board | Confirm the server's view with `/api/board/<project>/subscribers`. Agents are given `CORAL_URL` and `CORAL_DATA_DIR`; a custom wrapper that clears the environment can lose them. |
| Agent launch fails with a tmux error | tmux was chosen (Settings > Terminal or `--backend tmux`) and is missing. The macOS app bundles it. Coral starts anyway and only fails at launch time; choose the built-in terminal (Settings > Terminal, or `--backend pty`) or install tmux. |

## Stop only what you started

Never `pkill`, `pkill -f`, `killall` or `kill $(pgrep ...)` by a name or a pattern. `-f` matches the whole command line, and an agent's own command line holds the prompt it was launched with: a pattern such as `go test ./...`, `coral` or a worktree path ends the other agents whose prompt mentions it, and the person sees three agents quit in the same second with nothing in the log (#11157). Start the process you want to stop in the background yourself and stop that one: `cmd & pid=$!` then `kill "$pid"`, or `kill %1`; for a test run, let it finish or bound it with `timeout 600 go test ...`. Ask the person before ending a process you did not start.

## Next

- [Teams and multi-agent runs](teams.md) — and read
  [Worked demos](worked-demos.md) first for what team isolation does and does not do.
- [Message board](board.md)
- [Scheduled jobs](scheduled-jobs.md)
