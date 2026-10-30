<p align="center">
  <strong>Coral: the inbox for your agents, and an agentic IDE built for AI-first development.</strong>
</p>

<h2 align="center">
  <a href="https://coralhub.dev">Coral Hub: coralhub.dev</a>
</h2>

<p align="center">
  Reach your Coral computers from any browser, your phone included. Invite-only beta.
</p>

<p align="center">
  Run Claude Code, Codex, Antigravity CLI, and Pi as one team. Every question, permission prompt and finished piece of work lands in one place, waiting for you.
</p>

<p align="center">
  <a href="https://github.com/subgentic/coral/releases/latest"><strong>Download the latest release</strong></a><br>
  <a href="https://github.com/subgentic/coral/releases/latest/download/Coral.dmg">macOS (.dmg)</a> &bull;
  <a href="https://github.com/subgentic/coral/releases/latest/download/Coral-x64.msi">Windows installer (.msi)</a> &bull;
  <a href="https://github.com/subgentic/coral/releases/latest/download/Coral-x64-portable.zip">Windows portable (.zip)</a> &bull;
  <a href="https://github.com/subgentic/coral/releases/latest/download/coral-linux-amd64.tar.gz">Linux x86-64</a> &bull;
  <a href="https://github.com/subgentic/coral/releases/latest/download/coral-linux-arm64.tar.gz">Linux ARM64</a><br>
  <sub>or with Homebrew: <code>brew install --cask cdknorow/coral/coral</code></sub>
</p>

<p align="center">
  <a href="https://github.com/subgentic/coral"><img src="https://img.shields.io/github/stars/subgentic/coral?style=social" alt="GitHub Stars"></a>
  <a href="https://github.com/subgentic/coral/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="Apache 2.0 License"></a>
  <a href="https://subgentic.github.io/coral/"><img src="https://img.shields.io/badge/docs-live-blue" alt="Documentation"></a>
  <a href="https://discord.gg/qhfgY57AZn"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="https://subgentic.github.io/coral/">Documentation</a> &bull;
  <a href="#the-inbox">The inbox</a> &bull;
  <a href="https://discord.gg/qhfgY57AZn">Discord</a>
</p>

---

## What is Coral?

Coral is the inbox for your agents.

When you run several coding agents, the work you have to do is not typing. It is answering: an agent asks a question, wants a permission, finishes something that needs a look. In a pile of terminals those are easy to miss. In Coral they are in one list, **Needs you**, in the **Inbox**, and the agent waits for your answer.

Coral is also an agentic IDE designed for AI-first development. You do not edit code in it. You run a team of agents on your code, read what they did, and steer. Each agent has its own terminal, its chat with full history, its changed files with diffs, and its cost. The agents work on one message board, with goals and tasks, so they hand work to each other and you see the whole picture.

Coral is a single Go binary that runs on your laptop or on a remote box. It wraps the agent CLIs you already use (Claude Code, Codex, Antigravity, Pi). You keep your keys and your subscriptions. Coral does not call any AI API itself.

<p align="center">
  <img alt="The Coral dashboard: a team of agents on the left, an Orchestrator's chat in the middle, and the team's message board on the right" src="assets/readme/dashboard.webp" width="100%" />
  <br>
  <sub>The dashboard with a team of agents at work: the agent list, one agent's chat, and the team's message board. (Sample data.)</sub>
</p>

## The inbox

The **Inbox** is the first thing to open when you come back to your agents.

- **Needs you:** the agents that are waiting for you, a failed scheduled job or workflow run you have not opened, and an agent's question or permission prompt. Answer a permission prompt from the dashboard or from your phone.
- **Tasks:** the open tasks an agent assigned to you. Open one in place, read it in full, and reply on its thread; the agent that created it is told.
- **Goals** and **Artifacts:** the goals your teams work toward, and the files agents publish (tagged "for review" when a person must look before the task can close).
- **Saved:** a message you set aside with its bookmark, readable in full.

Approve and Request changes buttons on an artifact for review are coming in v2.0.10; today you review the file and reply on the task.

## An IDE for AI-first development

- **Teams of agents, mixed vendors.** A Claude orchestrator delegating to Codex workers and a Pi reviewer, on one board. Permissions are written once in Coral's words and translated into each CLI's own format.
- **Goals and tasks with contracts.** Tasks say what they are blocked by and on what outcome (`success`, `failure`, `termination`), and what artifacts they need. A review hold lets QA check a result before it unblocks the next step.
- **A message board agents wait on.** An agent runs `coral-board wait --from Orchestrator` and ends its turn. Coral wakes it when the reply lands: no sleep loops, no tokens spent watching a channel.
- **Chat with history.** Read what an agent said and did, tool call by tool call, and search one history across every vendor's transcripts.
- **The Files panel and diffs.** See an agent's changed files with diffs, against its last commit, its branch point or main, next to its chat.
- **Jobs and workflows.** Run a prompt on a cron schedule, each job run in its own git worktree, or chain shell and agent steps in a workflow.
- **Analytics.** Tokens and cost by model, team, branch and agent.
- **Working modes.** Tell a team how to share the folder (shared checkout, worktrees, merge queue, task queue). It is guidance for the agents; Coral does not create the worktrees.
- **Teams that survive you closing the lid.** Sleep a whole team; the conversations stay. Wake it later and each agent resumes its own session.

<p align="center">
  <img alt="An agent's changed-files panel: four files changed versus the previous commit, with an inline diff of cooldown.go and the agent's chat alongside" src="assets/readme/changed-files.png" width="100%" />
  <br>
  <sub>An agent's changes so far, with the diff open beside its chat. (Sample data.)</sub>
</p>

<p align="center">
  <img alt="The message board beside an agent's chat: posts from the Orchestrator and workers, and the Pause Board and Export buttons" src="assets/readme/board-and-chat.png" width="100%" />
  <br>
  <sub>Board on the right, agent on the left. Workers reply with @mentions, and Coral nudges an agent the moment something lands for it. (Sample data.)</sub>
</p>

<p align="center">
  <img alt="The Analytics view: token and cost totals, a cumulative spend chart, then cost tables by provider and by model" src="assets/readme/analytics.png" width="100%" />
  <br>
  <sub>Analytics: token and cost totals, spend over time, and the same cost cut by provider, model, team, branch and agent. (Sample data.)</sub>
</p>

**Coral is open source (Apache-2.0).**

## Quick Start

### Download a release

Download the latest release from [GitHub Releases](https://github.com/subgentic/coral/releases/latest). These links always point to the newest version:

- **macOS**: [`Coral.dmg`](https://github.com/subgentic/coral/releases/latest/download/Coral.dmg) (universal binary), or `brew install --cask cdknorow/coral/coral`
- **Linux**: [`coral-linux-amd64.tar.gz`](https://github.com/subgentic/coral/releases/latest/download/coral-linux-amd64.tar.gz) (x86-64) or [`coral-linux-arm64.tar.gz`](https://github.com/subgentic/coral/releases/latest/download/coral-linux-arm64.tar.gz) (ARM64, e.g. Graviton or Docker on Apple silicon)
- **Windows**: [`Coral-x64.msi`](https://github.com/subgentic/coral/releases/latest/download/Coral-x64.msi) (installer) or [`Coral-x64-portable.zip`](https://github.com/subgentic/coral/releases/latest/download/Coral-x64-portable.zip). These are currently **not code-signed**, so Windows SmartScreen warns that the publisher is unknown. Verify the file with the attestation check below before you run it.

Each release also keeps its versioned file names (`Coral.v<version>.dmg`, `coral-linux-<arch>-<version>.tar.gz`, `Coral-<version>-x64.msi`, `Coral-<version>-x64-portable.zip`): the same files.

#### Verify your download

Every release is built and signed by Coral's release workflow on GitHub, with no long-lived keys (Sigstore keyless signing). You can check that a download came from that workflow, from a release tag of `subgentic/coral`. Releases up to v1.4.141 were built before the repository moved, in `cdknorow/coral`: for one of them use `--owner cdknorow` and `cdknorow/coral/.github/workflows/release.yml` in the commands below (GitHub keeps a release's attestation with the owner that built it, so `--repo` finds nothing for them).

With the [GitHub CLI](https://cli.github.com/) (any package):

```bash
gh attestation verify coral-linux-amd64.tar.gz --owner subgentic \
  --signer-workflow subgentic/coral/.github/workflows/release.yml
```

Offline, with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) v2.4 or later: download `SHA256SUMS.txt` and `SHA256SUMS.txt.sigstore.json` from the same release, then:

```bash
cosign verify-blob SHA256SUMS.txt --bundle SHA256SUMS.txt.sigstore.json --new-bundle-format \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/subgentic/coral/\.github/workflows/release\.yml@refs/tags/v'
sha256sum --check --ignore-missing SHA256SUMS.txt   # macOS: shasum -a 256 --check --ignore-missing
```

The checksum command must print `<your file>: OK` for the file you downloaded; if it prints nothing, nothing was checked.

On Windows, check the MSI or the portable ZIP you downloaded the same way (PowerShell, with the GitHub CLI); it must report the attestation as verified for `release.yml` on a tag of `subgentic/coral`:

```powershell
gh attestation verify Coral-x64.msi --owner subgentic `
  --signer-workflow subgentic/coral/.github/workflows/release.yml
```

This proves the file came from Coral's release workflow. It is not Windows code signing: the MSI and the programs in it carry no Authenticode signature yet. The `SHA256SUMS.txt` check above covers the Windows files too.

Each Linux tarball also has its own bundle (`coral-linux-<amd64|arm64>.tar.gz.sigstore.json`, and the same for the versioned name), verified the same way. The bundles are in Sigstore's current bundle format: cosign 2.x reads them only with `--new-bundle-format` (without it, it fails with "bundle does not contain cert for verification"); cosign 3 reads them either way. Either check failing means the file is not an official build: don't run it.

### Install and start

First install and sign in to at least one agent CLI: [Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://github.com/openai/codex), [Antigravity (`agy`)](https://antigravity.google), or [Pi](https://pi.dev). Coral runs these tools; it does not install or authenticate them.

- **macOS:** Open the DMG, drag `Coral.app` to Applications, then open Coral. The app includes tmux. For terminal commands, run `/Applications/Coral.app/Contents/MacOS/install-cli.sh` and add `~/.local/bin` to your `PATH`.
- **Windows:** Run the MSI, then open **Coral** from the Start menu. For the portable ZIP, extract it, open PowerShell in that folder, and run `.\coral.exe --no-browser`.
- **Linux:** Download the archive for your architecture, then extract and start it (ARM64: replace `amd64` with `arm64`):

  ```bash
  mkdir -p "$HOME/.local/share/coral"
  tar -xzf coral-linux-amd64.tar.gz -C "$HOME/.local/share/coral"
  export PATH="$HOME/.local/share/coral:$PATH"
  coral --no-browser
  ```

  Add that `PATH` line to your shell's startup file for later terminals. Agents run in Coral's built-in terminal and stop when you quit Coral. To keep them running after Coral quits, install tmux and start Coral with `--backend tmux`.

On first launch, review the Terms of Service and accept them if you agree. For a terminal launch, keep the terminal open while Coral runs. Open the local address printed at startup. If the browser shows **Create a password**, enter and confirm a password, then choose **Create password and open Coral**. The app can open a signed-in browser directly; you can also run `coral open` from a terminal on the server.

In the dashboard, choose **New agent**, pick or accept the folder, press Next twice (the persona is optional), choose the agent CLI on the last step and press **Launch**. In the agent's **Terminal**, answer any folder-trust or sign-in prompt, then send a task from **Chat** with Enter. Use **New project** on Home to start a team.

See [Getting started](https://subgentic.github.io/coral/getting-started/) for the full installation and first-agent walkthrough.

### Build from source

Install Git, Make, Go 1.26.10 or later, and a C compiler (on macOS, Xcode Command Line Tools), then:

```bash
git clone https://github.com/subgentic/coral.git
cd coral/coral-go
make build
./bin/coral --backend pty --no-browser
```

The build puts the tools in `bin/`. For the commands below, add that directory to your `PATH` or use `./bin/coral` in place of `coral`.

### Run it on a remote machine

Coral doesn't have to run where you sit. Start it on a dev box, a home computer, or a cloud VM and the agents run there in their own terminal sessions until you stop them:

```bash
coral --remote --host 0.0.0.0 --port 8420
```

Then open `http://<that-machine>:8420` from any browser. Sign in with your Coral password, or use **Mobile QR code** (on Home, or in Settings > Network and Hub) to open a signed-in link on another device. See [Remote access](https://subgentic.github.io/coral/remote-access/) for setup. Agents on a second Coral computer can subscribe to the first one's board, so a team can span machines.

### Docker or a headless box

Coral uses its built-in terminal by default, so agents stop when Coral stops; to keep them running across restarts, start Coral with `--backend tmux` (tmux installed).

Run Coral in an interactive terminal for the first start so you can accept the Terms of Service and answer the remote-access question. With Docker, allocate a TTY (`docker run -it`) and publish port 8420 (`-p 8420:8420`). Inside the container or your SSH session, run:

```bash
coral --host 0.0.0.0 --port 8420 --no-browser   # asks about remote access
```

Answer **y** to enable remote access. Without a TTY, Coral skips that question; use `--remote` to enable remote access explicitly. Open `http://<computer>:8420` in your browser. If **Create a password** asks for a setup code, run `coral setup-code` on that computer, or `docker exec -it <container> coral setup-code` inside the running container, and enter the code in that form. Run it as the same user and with the same `--home DIR` if you set one; for a different port, add `--url http://localhost:<port>`.

### Use it from your phone

Press **Mobile QR code** and scan the code: it signs that phone in, so show it only to a device you own. Coral opens as a purpose-built mobile client — installable to your home screen, laid out for a phone rather than a shrunken desktop.

<p align="center">
  <img alt="The dashboard on a phone: the live sessions list, and an agent's chat" src="assets/readme/dashboard-on-a-phone.png" width="100%" />
  <br>
  <sub>The same dashboard on a phone: the agent list, and one agent's chat. (Sample data.)</sub>
</p>

From it you can:

- Watch every agent's live terminal and its state
- Read and post on the board, and check task status
- Approve or deny an agent's permission prompt the moment it appears
- Sleep, wake, restart, or kill agents

It talks to the same server over your network, so nothing runs on the phone and there's no separate app to install.

### Coral Hub (beta)

Coral Hub (app.coralhub.dev, invite-only beta) lets you reach your Coral computers from any browser without opening a port. A fresh install never connects, or asks you to, on its own: connect a computer from the home screen or **Settings > Network and Hub**, or run `coral cloud connect` on it. Coral offers it at first launch (the dashboard's Connect screen and a prompt in the terminal) only when you pass a hub URL (`--cloud-url https://app.coralhub.dev` or `CORAL_CLOUD_URL`) or start it with `--cloud-connect prompt` (`CORAL_CLOUD_CONNECT=prompt`); `--cloud-connect off` turns that off. See [Coral Hub](coral-go/agent_docs/hub.md#connecting-a-server-to-coral-hub).

## Documentation

Full documentation at **[subgentic.github.io/coral](https://subgentic.github.io/coral/)**.

## Contributing

We welcome contributions! Whether it's adding support for new AI agents, improving the dashboard, or fixing bugs, please open an issue or submit a pull request.

Dashboard changes should follow the [Coral UI style guide](coral-go/docs/ui-style-guide.md).

## License

Apache 2.0 License. See [LICENSE](LICENSE) for details.

---

<p align="center">
  <a href="https://github.com/subgentic/coral">Star the repo</a> &bull;
  <a href="https://discord.gg/qhfgY57AZn">Join Discord</a> &bull;
  <a href="https://subgentic.github.io/coral/">Read the docs</a>
</p>
