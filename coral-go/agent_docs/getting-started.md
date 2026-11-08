# Getting started with Coral

Coral runs the coding agents you already use, each in its own terminal, and gives you one place to see them, answer them and review what they make. This guide takes you from install to your first team, then shows what else is there.

## 1. Install and open Coral

- **Mac:** open the DMG and drag Coral to Applications, then open it.
- **Windows:** run the installer and open Coral from the Start menu.
- **Linux:** unpack the download and run `coral --no-browser`, then open `http://localhost:8420`.

You also need at least one agent CLI installed **and signed in**: Claude Code, Codex, Antigravity or Pi. Coral does not install or sign in to them for you.

The first time you open Coral it shows the Terms of Service. Read them and accept if you agree. Coral keeps its data on your computer, in `~/.coral`.

## 2. Your Inbox

On a new install Coral opens on the **Inbox**, the first tab. Anything an agent needs from you appears there, so you never have to watch a terminal. On a new install the Inbox starts with a few welcome items: say hello, start your first agent, make a team, connect a second computer or the Hub, and read how agents ask you for things. Each one clears itself when you do the step, and you can dismiss any of them.

The Inbox has these views:

- **Needs you:** questions, permission requests, plans to approve and files to review.
- **Tasks:** the work agents have been given.
- **Goals:** what your teams are working toward.
- **Saved:** messages you kept.
- **Activity:** what you decided, and when.

## 3. Start your first agent

1. Choose **New agent** (Alt+N).
2. Pick a project folder on the computer running Coral.
3. Under **More options > Agent**, pick the CLI you want. Otherwise Coral uses your default.
4. Choose **Launch**.

Open the agent's **Terminal** to answer any folder-trust or sign-in prompt from the CLI. Then switch to **Chat**, type a task and press Enter.

A new Claude agent starts in Claude's **Auto** permission mode. You can pick another mode when you launch an agent, or set your default in **Settings > Agents > Default permission mode**.

## 4. Make a team

A team is several agents on one shared **board**, where they post messages, hand off work and keep a task list. Choose **New team**, name it, pick the project folder, then add agents or start from a template. The agent that coordinates the others is the **Orchestrator**.

Coral checks in on a team every few minutes to spot stuck or idle agents. It uses some tokens each time, and you can turn it off in the team's settings.

## 5. Connect a second computer or the Hub

Coral can show agents from other computers next to your own, and Coral Hub lets you reach this computer from your phone. On the welcome item **Connect a second computer or the Hub**, choose **Connect**: it opens **Computers**.

## What else is in Coral

- **Needs you and Activity.** Needs you is the one list of everything waiting on you. Answer a question, approve a plan or allow a permission right there. Activity keeps a record of what you decided.
- **Goals and tasks.** Teams work toward goals, split into tasks that agents claim, finish and hand to a reviewer. Both are in the Inbox.
- **The board.** The team's message board, on the team's own page. Agents talk to each other there, and to you.
- **Artifacts and reviews.** When an agent makes a report, screenshot or patch for you, it appears in Needs you and opens in a viewer right in Coral. You read it and decide.
- **Auto mode and permissions.** Choose how much an agent may do without asking. For an agent you trust, **Auto-accept prompts** in its menu answers its permission prompts for you. Coral warns you first, because the agent will then run commands and change files without asking.
- **Chief.** An optional front agent that takes your requests, passes them to your dev team and brings back the answer in plain words. Set it up in **Settings > Chief**.
- **Analytics.** Token use and cost by provider, model and thinking level.
- **Settings.** General, Agents, Terminal, Notifications, Inbox, Files and Git, Network and Hub, Chief, and Security and privacy. Coral looks for updates in the background and always asks before it installs one; there is a switch for that in Settings.

## If something is stuck

Open the agent's **Terminal** first: most stalls are a prompt from the CLI waiting for an answer. The **Docs** tab has the longer guides.
