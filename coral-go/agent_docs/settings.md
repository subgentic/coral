# Settings: what each one does

> Plain words for the Settings you can change in the dashboard. Each section is named as the setting reads on screen; its Learn more link opens here.

Open Settings with the gear at the top right. Switches and fields save as you change them. For the settings API that the dashboard calls, see [Settings & System API](settings-system.md).

## Tell me when a new version is out

Shows a notice in this browser when a newer Coral is available. It only tells you: downloading and installing are under Updates.

## Desktop alerts

An alert on this computer while this tab is in the background, for example when an agent needs you. It works in this browser only. The alert shows the agent and computer names (your system may keep them in its notification history) and never agent output. It can repeat an alert Coral already showed.

## Custom models

Add model names the CLI should accept even when Coral does not list them. The name is passed to the CLI exactly as you wrote it. Custom models appear in every model picker, including the one that switches a running agent's model.

## Custom permission modes

A custom permission mode is a named set of the CLI's own permission flags, one flag per line. Custom modes appear after the built-in ones wherever you choose a permission mode. Coral only accepts the permission flags of each CLI, and checks them again at every launch. The New agent dialog shows the exact command a mode starts the agent with.

## Default working directory

The folder a new agent starts in, when you do not pick another one.

## Default thinking

How much Claude thinks before it answers, for agents launched with no choice of their own. A model that does not take that level uses the nearest one it does.

## Resume after API errors

When an agent's CLI stops on a rate limit, an overload or another API error, Coral wakes it again after about 2, then 5, then 15 minutes, and stops trying after the third. Waking the agent yourself starts the count again.

## Name each agent's goal

Coral asks Claude Code's smallest model (Haiku) for a short goal line for each agent, from your requests only: once when the agent first answers, then for a new request at most every 30 minutes. Each one is a short call made with your Claude Code account (about 1,300 input tokens). When this is off, the goal shows your first prompt.

## Run agents at lower priority

Agents and everything they start (builds, test runs) run below Coral itself, so the dashboard, Coral Hub and your own apps stay quick while agents use every CPU. It changes scheduling only, never what an agent may do. It applies to agents started after you change it.

## Attach files linked in posts

When this is on, an agent's own board post that links a local image (png, jpg, gif, webp) or Markdown file changed in the last day has that file stored as an artifact, so the team and Coral Hub can open it. When it is off, the links stay as written and agents upload with `coral-agent artifact upload`.

## Coral artifact reminders

When an agent publishes to claude.ai, Coral types one note into its terminal asking for a Coral artifact instead (`coral-agent artifact upload`) and a link to it. It does this once per artifact, and Coral never uploads or posts for the agent. When this is off, nothing is typed.

## Enable launch into git worktree (experimental)

Experimental, and off until you turn it on: a team can then be launched into its own git worktree, an isolated checkout of your repository.

## Skip Codex's review of Coral's hooks

Codex asks you to review new hooks before it runs them, because a trusted hook runs outside its sandbox. When this is on, Coral trusts its own hooks, and only those exact commands, for each Codex agent it launches, so the agent starts without that question. Your own hooks, a repository's and a plugin's still ask. When it is off, Codex asks every time. It applies to Codex agents launched after the change, and it can only be changed on this computer.

## Fit pane width

With the tmux terminal backend, the terminal takes the size of this browser window.

## Terminal backend

This decides what happens to your agents when Coral restarts.

- **tmux** keeps agents running when Coral restarts, upgrades or crashes, and Coral picks them up again afterwards. Coral keeps its terminals in a tmux server whose socket sits in your Coral data folder, so any agent, and any other program running as you, can find that socket and read or type into other agents' terminals. Choose it if you restart or upgrade Coral often.
- **pty** (the default) means Coral holds each terminal itself, so there is no shared socket for an agent to use against another agent. The price: agents end whenever Coral restarts, upgrades or crashes. Coral puts them to sleep first when it stops cleanly. When it starts again it wakes them one at a time and they resume their conversation, but a tool that was running is not continued.

On Linux, a program running as you can still reach Coral's terminals through `/proc`, so pty protects agents from tmux-style access, not from every program running as you.

## Wake agents after a restart

Coral wakes the agents that were running when it stopped, one at a time when it starts, and they resume their conversation with the permissions they ran with, including an agent that bypassed permissions. If there are more than the number set below, Coral asks first. Agents you put to sleep stay asleep.

## Agent tools folder

Agents run `coral-board`, `coral-agent` and Coral's hooks from this folder. The row is shown only when Coral has something to tell you about it, and the line under it says what.

## Git scan interval

How often Coral rescans git for changed files. Scanning a large repository is slow: stretch this out, or turn it off and use the refresh button.

## Artifact store limit

The most space stored artifacts may take. Above it, agents' new uploads are refused until you delete some (Team Artifacts > Delete). 0 means no limit. Saved task and session diffs are not counted.

## Received files limit

The most space received files may take. These are files sent to this computer by other teams and Corals. Above the limit new received files are refused; nothing is deleted, and your agents' own uploads are not affected. The default is 2 GiB; 0 means no limit.

## Older than

The age, in days, that Prune and Shrink use. Prune deletes saved diffs of finished tasks and stopped sessions, and artifacts nothing links, older than the days you choose. Shrink rewrites saved diffs of finished tasks without secrets, dot-files, binaries and big files (the code changes stay). Kept artifacts and anything still linked are never touched. Each shows what it would do first.

## Prune every hour

Does the same as Prune by itself, once an hour. After you turn it on, nothing is removed until you review what it would do, or 24 hours later; each run frees at most 2 GiB.

## Terminal logs

Each agent's terminal output stays in the logs folder of Coral's data folder. Deleting removes the logs of agents that have ended; the log of a live, sleeping or archived agent is never touched.

## Examples

Example jobs and workflows are there to show what Automations does. Removing them deletes only those; your own jobs and workflows stay.

## Board message search

On by default. The search index takes disk, about 0.6 times the text of the messages, and is built in the background after Coral starts: a search reads every message until it is ready. To turn it off, start Coral with `CORAL_BOARD_SEARCH_INDEX=off`; the index is then dropped.

## Kept worktrees

Git worktrees Coral made for teams and jobs and kept when they stopped. Remove one when you no longer need it. Coral never forces a removal, so unsaved changes or unmerged commits keep it.

## Remote access

Lets other devices control agents and read files as you do; it is unencrypted unless TLS is on. They can also change settings. TLS is on when Coral was started with `--tls-cert` and `--tls-key`, or when you reach it through Coral Hub. A device needs your password or API key.

## Manage other computers from this one

Adds a Computers tab; whoever signs in here controls every computer you add. It uses this Coral's own address, port and sign-in: the API key from other computers, and Remote access above for who can reach it. Nothing new listens. Turning it off keeps the computers you added.

## Accounts

Agents sign in through each CLI's own login, not a key stored in Coral. Check asks Claude and Pi now; Pi signs in per provider and says which one.

## Database encryption

Choose whether Coral's database on this computer is plain, protected by a local key file, or protected by a password you type at startup. A change applies after Coral restarts. Coral never stores a database password in browser storage, URLs, logs, or ordinary settings.

## Usage analytics

Anonymous product events only. No prompts, transcripts or secrets are sent.

## Record what Coral types (debug)

Saves everything Coral sends to agent terminals, including anything typed or pasted, such as passwords. It is for troubleshooting only: turn it off afterwards. It applies immediately.

## Coral Hub access limits

The hub can read everything you view through it. This is the most Coral Hub can ever do here: its owner can limit it further for each computer but never raise it, and only you can change it, here. Interact lets a hub user type into running agents, which can run commands; Launch also lets them start, stop, sleep, wake and restart agents. Disconnect removes the token from this computer; revoke the computer on the hub's Computers page to cut it off from there.

## Coral Hub can turn on auto-accept

While access is Launch, a hub user can let an agent's permission prompts be approved for it, for up to 8 hours (1 hour unless they choose otherwise). Turn this off to keep that on this computer only; it also stops any auto-accept the hub turned on and any Keep Full access choice the hub made. An agent that is running keeps the mode it has until its next restart.

## Let Coral Hub relaunch this Coral to install updates

Coral Hub can ask for the relaunch of a version this computer has already downloaded and checked; it cannot choose a version or start one that is not ready, and it cannot change this switch. It only works at the Launch level above. It is off until you turn it on: when it is on, the owner of the linked Hub account can update this computer without you being asked here. It is changed on this computer only.

## Let Coral Hub change cross-team settings

Coral Hub's owner can turn cross-team messaging and file sharing on or off for your teams. Turn this off to forbid it.

## Hide tokens from view-only hub users

Coral Hub shows everything an agent printed or wrote. With this on, tokens and keys that Coral's redaction rules recognise are replaced by "[redacted token]" before they leave this computer, for viewers who can only look (View). Viewers at Interact or Launch see everything: they can already run commands as you. The live terminal is never delayed, so a key typed one character at a time can show in part. On this computer nothing is hidden.

## Let Coral Hub act as the Operator

At Interact or Launch a hub user can create, assign and complete tasks and post as the Operator here. Each action shows which hub user did it ("Operator via Coral Hub"), agents are told it came through Coral Hub, and it is recorded. Board settings can never be changed through Coral Hub. Turn this off to keep the Operator on this computer only.
