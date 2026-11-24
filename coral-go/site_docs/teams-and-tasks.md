---
title: "Coral teams and tasks"
description: "Start a Coral team with named roles and a shared message board, then use the task queue to assign work and make handoffs explicit."
---

# Teams and tasks

A Coral team gives agents named roles, a shared message board, and a task queue. Use tasks to describe work, assign an owner, and make handoffs explicit. If you have not launched an agent yet, start with [Getting started](getting-started.md).

## Start a team

1. Choose **Launch team** on the dashboard.
2. Choose a team template or configure the agents and their roles. Review the working directory, agent types, and prompts before launching.
3. Select an agent to open its workspace. Use the team's board to follow messages and tasks.

Open **Team view** from the team's controls to see members, observed activity, and assigned work. Assigned work can still be waiting in the queue; it does not necessarily mean the agent is working on it now.

Team settings include working-mode guidance such as shared checkout or worktrees. The guidance is attached when a task is first claimed; already-claimed tasks retain their instructions. Choosing worktree guidance does not itself create worktrees.

### Solo team templates and weekly reminders

Under **Start from a template** on the **Members** step of **New team**, each built-in template is a tile with its name, what the team does, what you do, and its role count. Alongside **Coding Team**, **Consumer Research** and **Dungeon Master**, five three-role templates are built for one person:

- **Overnight run** (`Orchestrator`, `Builder`, `Checker`): *A planner, a builder and a checker work your goal through the night. You leave a goal at night; a morning summary waits in Needs you.* Starts with a daily `07:30` morning-summary reminder on the `Orchestrator`.
- **Builder and reviewer** (`Orchestrator`, `Builder`, `Reviewer`): *One agent writes the change and an agent from another vendor reviews it. You give the goal and approve every change before it lands.*
- **Bug sweep** (`Orchestrator`, `Reproducer`, `Fixer`): *One agent works through your issue list, one reproduces each bug and one fixes it. You point it at the issue list and read the daily summary of fixed and stuck items.* Starts with a daily `17:00` summary reminder on the `Orchestrator`.
- **Docs and tests catch-up** (`Orchestrator`, `Test Writer`, `Docs Writer`): *A tests writer and a docs writer cover the code that changed this week. You get a weekly catch-up and review what it adds before it lands.* Starts with a weekly Monday `09:00` (`Mon 09:00`) reminder on the `Orchestrator`.
- **Research and write-up** (`Orchestrator`, `Researcher`, `Writer`): *A researcher gathers sources and a writer turns them into one report. You give the question and review the report before it is final.*

To add a weekly reminder from the dashboard (on an agent's Reminders section in **Team > Agents**), choose **Schedule > Weekly**, pick **Day** (`Monday` to `Sunday`) and **Time** (in this computer's time zone), and choose **Save reminder**. From the command line, run `coral-board remind add "<text>" --weekly "Mon 09:00"` (with optional `--tz <zone>`).

### Review size guard

In a team's **Settings** tab, open **Review size guard** (on this computer only, not through Coral Hub) to warn reviewers when a task in review has a large diff. It is **off by default** and never blocks a review automatically:

- **Warn when a change is too big to review**: turns the warning on or off.
- **Lines changed over** (`0` to `1,000,000`) and **Files changed over** (`0` to `100,000`): whole numbers. Either limit warns; leave one empty to check only the other.
- **Skip these paths (not counted)**: comma-separated path patterns (such as `*.lock, **/generated/**`; `*`, `?` and `**` work).
- **Over the limit**: **Warn: show a banner** (the default), **Send back: ask the author to split**, or **Split: the Orchestrator files follow-ups**. **Send back** and **Split** add a button to the banner; nothing happens until someone presses it.
- **Applies to**: **Whole team** or **Only these roles** (then select one or more **Roles**).

When a task in review exceeds a limit for its author's role, the task page shows a **Large change.** warning banner above the task details with the changed lines and files, your team's limit, and any skipped lines and paths:

- **Warn: show a banner**: shows *This is a warning only. You can still review and approve it.*
- **Send back: ask the author to split**: adds **Send back to author** (*Your team sends a change this size back to its author.* / *You can still approve it.*). Pressing it opens **Send back to `<author>`?** with an editable **Note to the author** pre-filled with the change's size and limit; **Send back** returns the task to its author to split and resubmit.
- **Split: the Orchestrator files follow-ups**: adds **Split into follow-ups** (*Your team splits a change this size into follow-up tasks.* / *You can still approve it.*). Pressing it opens **Split `#<id>` into follow-ups?**; **Ask the Orchestrator to split** posts a request on the board for the team's Orchestrator to file follow-up tasks under the limit while the review stays open.

## Create and inspect tasks

From the team's task list, create a task with a clear title and description. Choose a priority and, optionally, an assignee. You can also save a draft and use **Publish** when it is ready for the queue.

For a handoff, use **Add dependency** to select prerequisite tasks. The creation form also lets you specify a dependency condition and required artifact names, plus the outputs this task should produce. For example, an implementation task can produce a named build artifact that a dependent review task needs.

Open a task to inspect its description, assignment, status, dependency conditions, and completion evidence. An **Open · Blocked** task is waiting for prerequisites. Finishing an upstream task is not always enough: its outcome and any required artifacts must satisfy the selected condition. Completion evidence is supplied by agents; inspect it before treating a task as verified.

The task detail view offers **Nudge** and reminder controls for eligible assigned tasks. These send reminders to the agent; they do not complete the work.

## Change an assignment or dependency

Open an editable task, choose **Edit**, change **Assigned To**, and save. The edit form is available for blocked tasks as well as other unfinished tasks. Reassigning a blocked task changes its owner; its prerequisites still need to be satisfied.

For a pending, blocked, or draft task, **Edit** includes **Blocked By**. Add or remove a prerequisite there if the dependency was specified incorrectly. Removing a dependency changes the workflow requirement; it is not evidence that the prerequisite succeeded. Once a task is in progress, that dependency picker is not offered.

Changes to the description or workflow instructions require an **Amendment reason**. Use it to explain what changed to the agent doing the work.

Use **Cancel Task** for unfinished work that should no longer proceed. Cancellation is distinct from successful completion. Blocked and draft tasks do not offer the normal **Complete** action. Review-controlled tasks may have a different set of actions.

Agents can also use these commands from their existing Coral team session:

```sh
coral-board task list
coral-board task detail 123
coral-board task claim 123
coral-board task reassign 123 --to "Reviewer"
coral-board task cancel 123 --message "Superseded by a replacement task"
```

Replace `123` and the assignee with the actual task and team member. A task's detail is the place to check its current requirements before acting.

## Merge queue

When several agents each produce a patch and one person or role lands them, turn on the merge queue: open Team settings, choose **Merge queue** as the working mode, and save. Every agent's instructions then say how to work: in a worktree, with the patch attached to the task, and with landing left to the person who lands.

Reviewers approve the exact patch (by its digest), so a patch changed after approval needs a new review. `coral-board queue` shows the approved patches that have not landed, oldest first; the person who lands applies them with git, then records them with `coral-board task mark-landed`. A patch that does not apply goes back to its author with `coral-board task send-back`. The queue works on this computer only; Coral Hub does not carry it. The details for agents are in the [merge queue guide](https://github.com/subgentic/coral/blob/main/coral-go/agent_docs/merge-queue.md).

**Who lands.** The orchestrator, or the role your team names in its instructions. Only the orchestrator or you, the Operator, can send a patch back or mark it landed. Coral never applies, merges or pushes a patch itself: landing is always a person or agent using git, and the queue only tells them what is approved. **Guidance for dependent tasks** in Team settings is a separate option that asks agents to split work into dependent tasks with named outputs.

## Share the result

Ask agents to attach reports, screenshots, and other outputs to their task results. See [Files and artifacts](files-and-artifacts.md) for uploads, task attachments, and previews. For an interactive diagram or dashboard inside Coral, use [Agent UI](agent-ui.md).

For setup or delivery problems, see [Troubleshooting](troubleshooting.md). See [Privacy](privacy.md) for data-handling details.
