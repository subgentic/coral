---
title: "Getting started with Coral"
description: "Install Coral on macOS, Linux or Windows, launch your first coding agent, and see its terminal, chat and tasks in the dashboard."
---

# Getting started

Coral runs the agent CLIs you already use, each in its own terminal session, and gives you one dashboard and message board for all of them.

## What you need

| Requirement | Notes |
|---|---|
| **An agent CLI** | Claude Code (`claude`) or Codex (`codex`), installed **and signed in**. Coral does not install or authenticate these. Follow each vendor's own instructions: [Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://github.com/openai/codex). (Coral also supports Antigravity `agy` and Pi `pi`.) |
| **git** | Needed for worktree, branch and diff features. |
| **tmux** | Optional. Coral runs agents in its own built-in terminal by default; tmux is for agents that keep running when Coral quits. Included in the macOS app; Linux needs your own tmux if you choose it. See [Platforms](#platforms). |

## Platforms

| Platform | Regular release asset | tmux |
|---|---|---|
| **macOS** (13 or later) | [`Coral.dmg`](https://github.com/subgentic/coral/releases/latest/download/Coral.dmg), a universal (Apple Silicon and Intel) signed and notarized app | Bundled tmux 3.7c with its terminal definitions. Keep the app bundle intact. |
| **Windows** (x64) | [`Coral-x64.msi`](https://github.com/subgentic/coral/releases/latest/download/Coral-x64.msi) (installer) or [`Coral-x64-portable.zip`](https://github.com/subgentic/coral/releases/latest/download/Coral-x64-portable.zip). Not code-signed: SmartScreen warns that the publisher is unknown, so check the file as the [README](https://github.com/subgentic/coral#verify-your-download) describes before you run it. The default port is 8450, not 8420. | Not used: Windows uses the native PTY backend (ConPTY; there is no tmux on Windows). |
| **Linux** (x86-64 or ARM64) | [`coral-linux-amd64.tar.gz`](https://github.com/subgentic/coral/releases/latest/download/coral-linux-amd64.tar.gz) (x86-64) or [`coral-linux-arm64.tar.gz`](https://github.com/subgentic/coral/releases/latest/download/coral-linux-arm64.tar.gz) (ARM64), statically linked CLI/server tools, no desktop app | Not bundled. Optional: install tmux yourself if you choose the tmux backend. |

These file names always point to the newest release. Each release also keeps versioned names (`Coral.v<version>.dmg`, `Coral-<version>-x64.msi`, `Coral-<version>-x64-portable.zip`, `coral-linux-<arch>-<version>.tar.gz`): the same files.

The macOS 13 minimum is checked in the shipped binaries. It has not been tested on a macOS 13 machine.

## 1. Install

On **macOS** and **Linux**, you can install the latest verified release with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/subgentic/coral/main/install.sh | bash
```

What it does:
- Downloads the latest release package for your OS and CPU over HTTPS and checks it against `SHA256SUMS.txt` (and verifies the Sigstore signature when `cosign` is installed).
- On **macOS**, verifies that `Coral.app` is signed and notarized, installs `Coral.app` in `~/Applications` (without `sudo`), and links the command-line tools into `~/.local/bin`.
- On **Linux**, unpacks Coral's programs (`coral`, `coral-board`, `coral-agent`, `launch-coral`, `coral-update`, and the hooks) into `~/.local/bin`.
- Pass `-s -- --dry-run` after `bash` to inspect what would be downloaded and installed without changing anything.

Or download directly from [GitHub Releases](https://github.com/subgentic/coral/releases/latest):

- **macOS (`Coral.dmg`):** Open the DMG and drag `Coral.app` to `Applications`. Agents that Coral launches can run Coral's own command-line tools without you changing PATH.
  - *Optional — use `coral` from your own terminal:* Run `/Applications/Coral.app/Contents/MacOS/install-cli.sh` to symlink the CLI tools into `~/.local/bin`, and add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` or `~/.bashrc`.
- **Windows (`Coral-x64.msi`):** Run the MSI installer, which installs Coral to `Program Files\Coral`, adds it to your `PATH`, creates a **Coral** Start Menu shortcut, and offers to launch Coral when setup finishes. (For `Coral-x64-portable.zip`, extract the zip and run `.\coral-tray.exe` or `.\coral.exe`.)
- **Linux (`coral-linux-amd64.tar.gz` or `coral-linux-arm64.tar.gz`):** Extract the tools into `~/.local/bin`:
  ```bash
  mkdir -p "$HOME/.local/bin"
  tar -xzf coral-linux-amd64.tar.gz -C "$HOME/.local/bin"
  ```

**If you once installed the old Python package** (`pip install agent-coral`), remove it. It installs commands with the same names and uses the same `~/.coral` directory and port, and can shadow this program. Check with `which -a coral` and remove it with `pip uninstall agent-coral`. Coral logs a warning at startup when it detects this.

## Updates

Coral on a Mac, on Windows and on Linux keeps itself up to date. In the background it looks for the newest promoted release on GitHub, downloads it and checks it (the Sigstore signature, the checksum and the Apple Developer ID team of the new app). It never installs on its own: when an update is ready the dashboard and the tray offer a button (Update and relaunch on a Mac and on Linux, Install update on Windows), and only then does Coral install it and start again. On a Mac it swaps in the new app, and puts the old one back if the new one does not stay up. On Windows it runs the new MSI as an upgrade, and Windows asks you to allow it.

- **Turn it off:** the automatic-updates switch in Settings, or start Coral with `CORAL_AUTO_UPDATE=off`.
- **Homebrew installs** are never updated by Coral: run `brew upgrade --cask coral`.
- **Windows:** only a Coral installed from the MSI updates this way; a portable copy never does (download the new zip). The Windows package is not code-signed yet: Coral accepts it on its checksum and the Sigstore signature alone. A rollback package is kept only when the version you had was itself a promoted release.
- **Linux:** a tarball install in a folder only Coral's own programs are in, and that you can write, updates by swapping the folder, and keeps the old one for the rollback. An install a package manager owns, a shared folder or one you cannot write is left alone: download the new release as for a first install. Development, beta and Coral For Dropbox builds do not check at all.

## 2. Open Coral

- **macOS:** Open **Coral** from `Applications` (or `~/Applications` if installed with `install.sh`). Coral starts its menu-bar tray icon and opens the Coral window.
- **Windows:** Open **Coral** from the Start menu (or leave **Launch Coral** checked on the installer's final screen).
- **Linux:** Run `~/.local/bin/coral`, which starts the server and opens the dashboard in your default browser at `http://localhost:8420`.

On first launch, review the Terms of Service and accept them if you agree, then set a password when **Protect Coral with a password** appears.

By default Coral stores data in `~/.coral`, uses port **8420** (port **8450** on Windows), and listens on this computer only (`127.0.0.1`). Agents run in Coral's built-in terminal (`pty`) and stop when you quit Coral; to keep agents running after Coral quits on macOS or Linux, choose `tmux` in **Settings > Terminal**. For a server on another computer, follow [Remote access](remote-access.md).

*Optional — starting from a terminal:* If you put `coral` on your `PATH`, `coral open` opens a signed-in browser tab for a running server, and `coral --version` prints the version. When running a server directly from a terminal (`coral --no-browser`), useful flags are `--home <dir>` (data directory, also `CORAL_DATA_DIR`), `--port <n>` (`CORAL_PORT`), `--host <addr>` (`CORAL_HOST`, only honored for network addresses when [remote access](remote-access.md) is enabled), `--remote`, and `--backend tmux|pty`.

## 3. Your first team (with the team builder and Orchestrator launch)

When you open Coral, the workspace screen asks **What do you want to work on?** with **New agent**, **New team**, and **New goal**.

1. **Start a team:** Choose **New team**.
   - **Step 1 of 3 (Your team):** Enter a team name (for example `first-team`) and choose your repository folder.
   - **Step 2 of 3 (Members):** You have three ways to pick your roster:
     - **Default team (3 members):** Starts an **Orchestrator**, a **Lead Developer**, and a **QA Engineer** right away.
     - **Describe your team:** Click **Describe your team** to generate a custom roster from a plain-English description.
     - **Let the Orchestrator build and launch the team (`orchestrator-team-builder`):** Launch just the **Orchestrator** (or start from **Default team** and remove the other members), then tell the Orchestrator in **Chat** what teammates and goal you want.
2. **What you see with `orchestrator-team-builder`:**
   - The Orchestrator inspects your repository (read-only), drafts a `team-plan.md` naming each teammate's role, CLI (`claude` or `codex`), model, thinking level, and initial tasks, and uploads it for your review:
     ```text
     coral://artifacts/d26734243be993e7ab199178398dffee04482b60dadfeb5af0cf5414a0435f6c
     ```
   - A red badge appears on **Inbox -> Needs you** with the question: *"Launch Dev and Reviewer on first-team as in team-plan.md?"*
   - Click **Approve** in **Needs you**.
   - The Orchestrator wakes up automatically, launches **Dev** and **Reviewer** on the team board (`[Coral] Orchestrator started Dev`, `[Coral] Orchestrator started Reviewer`), creates **Goal #1**, and assigns **Task #1** to **Dev**.

## 4. Your first review

1. **Worker submits for review:** **Dev** claims Task #1, writes the code and tests, verifies that `gofmt`, `go vet`, and `go test ./...` pass, and submits the task for review (`coral-board task submit-review 1`).
2. **What you see on the board and Tasks tab:**
   - Task #1 moves to `review_pending`.
   - The Orchestrator delegates the review to **Reviewer** (`[Task #1 delegated for review by Orchestrator] Reviewer (#2)`), creating review task **#2**.
   - **Reviewer** claims Task #2, inspects `git diff` and runs `gofmt -l .`, `go vet ./...`, and `go test ./... -v` independently in the repository, and approves the round (`coral-board task approve 1 --round 1`).
   - Coral automatically marks Task #1 **completed** (`[Task #1 completed by Orchestrator (approved by Reviewer)]`).

## 5. Your first artifact

Agents upload plans, test reports, diffs, and screenshots to Coral's content-addressed artifact store (`coral-agent artifact upload <file>`). Every artifact gets a SHA-256 digest and a `coral://artifacts/<digest>` link.

- **Where you see it:**
  - Open the team's **Artifacts** tab (or **Files -> Artifacts** in the left sidebar) to browse, search, preview, or comment on every file produced by the team.
  - When an agent tags an artifact `"for review"` (`--tag "for review" --question "..."`), it lands directly in **Inbox -> Needs you** under **For review**, where you can read the rendered Markdown or image, leave inline comments, and click **Approve** or **Request changes**.
  - For example, in our walkthrough, **Reviewer** uploaded `review-task1-round1.md` (`coral://artifacts/626cb21024f59101ebeb1564974d489bb148f91097b9fa1ea4b5a605eb3f5ddf`) summarizing the 16 passing subtests and verification checks.

## 6. What to do when stuck

| What you see | Why it happens & how to fix it |
|---|---|
| **Newly launched agent looks idle and produces no output** | On its first run in a repository, Claude Code (`claude`) or Codex (`codex`) stops at an interactive folder-trust prompt (`Quick safety check: Is this a project you created or one you trust?`) or a hook/permission prompt. Check **Inbox -> Needs you** or open the agent's **Terminal** tab and press `Down` then `Enter` to trust the folder (or toggle **Trust this folder** in Step 1 of **New team** before launching). |
| **Teammates launched by the Orchestrator sit waiting before their first post** | Agents started by the Orchestrator via `coral-agent launch` always start in ask-first (`default`) permission mode for safety. Open **Inbox -> Needs you** or their **Terminal** tab to approve their first command (or choose Claude's `Yes, and switch to auto mode`, or turn on **Auto-accept prompts** in the agent's `⋮` menu). |
| **You typed in an agent's Terminal and board notifications stopped arriving** | After you type in an agent's terminal, Coral pauses board nudges for **60 seconds** (`TypingHold`) so it never interrupts you mid-command. Wait 60 seconds after your last keystroke and Coral automatically flushes `[Coral] While you were talking: ...`. |
| **Codex agent cannot reach the board or upload artifacts** | Codex's default sandbox blocks `localhost` network calls. Launch Codex with Coral's default settings (or pass `-c sandbox_workspace_write.network_access=true`). |
| **`coral` starts an unfamiliar old server in a terminal** | The retired Python package (`pip install agent-coral`) is shadowing Coral on your `PATH`. Run `which -a coral` and `pip uninstall agent-coral`. |

## Permission mode

A new Claude agent starts in Claude's **Auto** permission mode: it runs without most prompts, and Claude's own background safety checks stay on. Coral no longer bypasses every prompt by default. Pick another mode in the launch form's **Permissions** section, or set your own default in **Settings > Agents > Default permission mode**; a mode you saved or chose stays as you set it, for every agent type. An agent started from Coral Hub gets Auto only when this computer allows Coral Hub to turn on auto-accept; otherwise it asks as Claude does by default. The other CLIs start as before: Codex and Antigravity use their own settings (Codex's Auto mode is a sandbox that cannot reach Coral's board on this computer, so Coral does not make it the default), and Pi has no permission modes.

## Auto-accept permission prompts

For an agent you trust with its task, you can let Coral answer its permission prompts for you: open the agent's menu (⋮) and turn on **Auto-accept prompts**. Coral warns you first, because the agent will then run commands, edit and delete files and use tools without asking, and that can include risky actions; use it only for trusted tasks, ideally in a sandbox or a disposable worktree. You can give it a time limit.

- Coral only approves tool-permission prompts, and only with "approve once"; it never picks "always allow". Questions, plan approvals and anything it does not recognise still wait for you.
- Risky actions such as deleting files, force-pushing, running `sudo` or changing files outside the agent's folder **can be approved**. Coral holds back some high-risk actions it recognises, as a best-effort safety net, not a guarantee.
- An amber **AUTO** chip marks the agent while it is on; click the chip in the agent's header (or use the menu) to turn it off. **Stop all auto-accept** in the top-bar menu turns it off everywhere.
- Every approval is listed in the agent's **Activity**. If the same prompt keeps coming back, Coral turns auto-accept off and tells you why.
- It turns off by itself when the agent restarts, resumes or wakes, or when its time limit runs out. It stays on if only Coral restarts while the agent keeps running.
- It runs on the Coral server, so it keeps working with the dashboard closed. From the Coral Hub it needs Launch access on this computer, and you can switch hub control off in Settings (**Coral Hub can turn on auto-accept**, on by default while access is Launch); a hub-enabled auto-accept always has a time limit of at most 8 hours.

## Running a second instance

Give it its own data directory **and** port, and keep the directory path short because a tmux socket path over about 104 characters (macOS) cannot bind:

```bash
coral --home /tmp/coral-two --port 8452 --no-browser
```

A non-default data directory no longer reads the default tmux socket, so it does not list the first instance's agents. Set `CORAL_TMUX_FALLBACK=1` only if you want the old merged view.

## Inbox: what needs you

The **Inbox** tab, in the top bar of every Coral (on a phone, in the view dropdown), is one page for what is waiting on you. It has two tabs (the same two as Coral Hub's Inbox; Coral remembers the one you last chose):

- **Needs you**: the agents that are waiting for input, each one a button that opens that agent. The number on the tab is how many are waiting.
- **Saved for later**: the messages you bookmarked (below), with an **Open** and a **Done** list.

On a Coral running as a hub over several servers, Saved for later shows every online server's items together, each naming its server. Through Coral Hub the Inbox tab is the hub's own Inbox page. The bookmark in the top bar always opens the Inbox at Saved for later, on every page, an agent's or a team's too, and its number is everything's open items (so the same on every page). **Escape**, a second press of the bookmark, or your browser's Back button leaves it.

## Save a message for later

Hover a message in an agent's Chat view (or a board message) and use its bookmark button, **Save for later**. A toast offers **View saved** (and **Undo** when you remove one). The list follows the page you are on:

| Where you are | Saved shows |
|---|---|
| An agent's page | That agent's bookmarks: its chat, and the board messages it wrote on its team's board. It is a **Saved** tab in the right-hand sidebar. |
| A team's page (opened from the agent list, or its board) | The team's bookmarks: its board's messages and its agents' chats. |
| Home, Chats, Workflows, Jobs, Analytics, Docs, Servers | Everything, in the Inbox. |

A heading says which ("Saved: QA Engineer", "Saved: my-team", "All saved"), and the **Open** and **Done** numbers and the tab's number are of that page; the top bar's bookmark is always the Inbox's, everything's list and number. The toast's **View saved** opens the page's own Saved tab. Each item shows where the message was said, a short snippet, and when it was said and saved. Newest saved is first; you can search and sort them (see the next section).

On an item:

- **Open chat**, **Open board** or **Open in Chats** (for an agent that has ended) takes you back to that point of the conversation: Coral loads older messages until it finds the message, outlines it and tags it **Saved**, with a bar above to go **Back to Saved**.
- **Done** moves it to the **Done** list (**Reopen** brings it back). **Remove** deletes the bookmark.

If the message is gone (the transcript no longer has it, or it was deleted from the board), the item is marked **Gone**, keeps its snippet, and can only be removed. The list is yours alone: agents cannot add to it, and the snippet is cleaned of tokens when it is saved. It lives on this computer in `sessions.db`; on a hub over registered servers each bookmark is kept on the server that has the conversation. Coral Hub's own dashboard does not have the button yet.

## Search and filter a list

The lists in the dashboard share one bar: a search box with a count beside it, a **Filters** button (it shows how many filters are on), a **Sort** menu where the list has one, and a chip for each filter that is on. The server does the searching, so it covers the whole list, not just what is on screen. Text is a plain, case-insensitive match (`%` and `_` are ordinary characters).

| List | The search box matches | Filters | Sort |
|---|---|---|---|
| Agents | an agent's name, display name, auto name or job title (the search box above the list) | State (needs input, working, idle, asleep), Board, Machine | List order, Name, Recent activity, Cost |
| Tasks | a task's title, body or completion message | Status, Priority, Agent, Updated since | Open first, Newest, Oldest, Recently updated |
| Board | a message's text | From, Mentions me, Since, Until | (in order; **First** and **Latest** jump, the arrows step through matches) |
| Team Artifacts | the name, the task title, who produced or sent it, the board it came from or went to, and the media type | Type (image, PDF, text, other), Origin (shared here, received, unlisted), Uploaded by, Kept only, From, Until | Newest, Oldest, Name, Size |
| Activity and History events | an event's summary or tool name (not its detail) | Type, From, Until, and which groups of events to show | Newest first, Oldest first |
| Saved for later | a bookmark's title or snippet | Type (agent chat or board message), conversation | Newest saved, Oldest saved |
| Servers | a server's name or address (the box appears from six servers up) | | |

- **The count** reads "12 agents" with no filter and "3 of 12" with one. A **+** after the total ("3 of 200,000+") means the search stopped at its limit and older items were not scanned; narrow it with a filter or a date. Activity searches show **Load more** for the next page.
- **Chips**: each filter that is on shows as a chip. Click a chip to remove that filter. With two or more on, a **Clear all** chip appears; **Clear all** is also at the bottom of the Filters menu.
- The screen reader hears the count after you stop typing, not on every key.

## Desktop alerts

Coral shows a toast in the page when an agent needs input. You can also turn on **Desktop alerts** in Settings to get a browser notification while the tab is in the background. Desktop alerts are this browser only; the alert shows the agent's name and the server's name, which your operating system may keep in its notification history. It never includes what the agent said or asked. On the machine running Coral, a desktop alert may duplicate the local alert.

## Next steps

- [Using the dashboard](using-the-dashboard.md)
- [Remote access](remote-access.md)
- [Privacy](privacy.md)
- [Troubleshooting](troubleshooting.md)
