---
name: creating-a-coral-automation
description: "How to design a Coral automation (a workflow of shell and agent steps, and a scheduled job that runs it) and hand it to the Operator, who creates it from the Automations tab. Use when asked to automate something that should run on a schedule or on demand."
metadata:
  published-by: Coral
  kind: example
---

# Creating an automation

An automation in Coral is one of two things:

- A **workflow**: up to 20 steps run in order. A `shell` step runs a command; an `agent` step runs an agent with a prompt. Each step can use the output of the one before.
- A **scheduled job**: runs on a cron schedule. It launches a one-shot agent with a prompt (a `prompt` job), or triggers a saved workflow (a `workflow` job).

**The Operator owns them.** The routes the Automations tab uses refuse every agent's session, so no agent creates, changes or triggers one there. Two ways to get one made:

- **You are a team's Orchestrator:** draft it yourself with `coral-board automation propose --file <json>`. It is stored OFF and appears in the Operator's Needs you with every step in full, its schedule and a hash. It runs only after the Operator's own Approve, and only exactly that version: any change you make turns it off and asks again. You can `list`, `show`, `change`, `disable`, `delete` and `run` (one test run, only of a version the Operator approved). You can never turn one on, and you do not set `board` or `enabled`.
- **Anyone else:** design it and hand it to the Operator, who creates it in the **Automations** tab (the Workflows and Jobs folders). The Workflows folder also has a **Build with Agent** button.

## Steps

1. Ask what should happen, and when: on demand, or on a schedule (every weekday at nine, every night).
2. Choose the shape. One prompt on a schedule is a `prompt` job. Several steps, or a command whose output an agent reads, is a workflow; a schedule on top of it is a `workflow` job.
3. Write the workflow as JSON, and the job's fields as the Operator will fill them in. Put both in a file for review (see the last section).
4. Say what it will cost and touch: each agent step spends CLI credit, and a shell step runs on the Operator's computer. Say it plainly.
5. Tell them how to switch it off: a job has an enabled switch in the Jobs folder.

## A workflow

```json
{
  "name": "nightly-check",
  "description": "Run the tests and have an agent summarize failures",
  "steps": [
    { "name": "test", "type": "shell", "command": "go test ./..." },
    { "name": "summarize", "type": "agent", "prompt": "Read the test output and summarize the failures and likely causes." }
  ],
  "default_agent": { "agent_type": "claude" }
}
```

- `name`: letters, numbers, `_` and `-`, unique. Every step has a unique `name` too.
- `type` is `shell` (needs `command`) or `agent` (needs `prompt`, and an `agent_type` on the step or in `default_agent`).
- 1 to 20 steps. `timeout_s` on a step is 1 to 86400 seconds. `max_duration_s` on the workflow defaults to 3600.
- `repo_path` and `base_branch` (default `main`) say where it runs; `cleanup_worktree` removes the worktree after the run.
- A step reads what the one before it printed through a template: `{{prev_stdout}}` is the path of the previous step's output file, and `{{prev_stdout_content}}` its content. The first step has no previous step.
- Ask an agent step to output only what the next step needs: it is passed on exactly as printed.

## A scheduled job

The fields the Operator sets, or that you hand over to them:

| Field | Meaning |
|---|---|
| `name`, `description` | what it is called, and why it exists |
| `cron_expr` | five fields: minute hour day-of-month month day-of-week. `0 9 * * 1-5` is nine in the morning, Monday to Friday |
| `timezone` | `Local` (the computer's) or a name such as `America/New_York` |
| `job_type` | `prompt` or `workflow` |
| `prompt` | for a `prompt` job: what the agent is to do |
| `workflow_id` | for a `workflow` job: which workflow |
| `agent_type`, `repo_path`, `base_branch` | for a `prompt` job: which CLI, and where it works |
| `max_duration_s`, `enabled` | the time limit, and whether it runs |

Suggest the job starts switched off until the Operator has seen the workflow run once by hand.

## What to keep out

- No keys, tokens or passwords in a command, a prompt or a hook: they are stored and shown. Say which setting or environment variable the Operator is to provide instead.
- No command that deletes, force-pushes or sends data off the computer, unless the hand-over says so in plain words.
- No step that triggers its own workflow.

## Hand it over

Write the design as one Markdown file: the workflow JSON, the job's fields, what it costs and touches, and how to turn it off. Upload it tagged for review, with the decision as the question:

```sh
coral-agent artifact upload nightly-check.md --tag "for review" --question "Create the nightly-check workflow and a 2 am job?"
```

Then post the link to the Operator. Once they have created it, they can run it once by hand from the Automations tab and read the run's output before the schedule starts.

## Drafting as an Orchestrator

The file for `coral-board automation propose --file`:

```json
{
  "name": "nightly-deps",
  "description": "Check dependencies for known advisories",
  "steps": [
    { "name": "scan", "type": "shell", "command": "./scripts/check_deps.sh --out reports/deps.json" },
    { "name": "summarize", "type": "agent", "prompt": "Read reports/deps.json and post one short summary to the team board.", "agent": { "agent_type": "claude", "model": "sonnet" } }
  ],
  "schedule": { "cron": "30 7 * * 1-5", "timezone": "America/Chicago" }
}
```

- It runs in the team's own repo folder: leave `repo_path` out. At most 10 steps, a command up to 4000 bytes, a prompt up to 8000, a schedule no more often than every 15 minutes, 6 proposals an hour, 10 held at a time.
- A shell step whose command is one plain call of a repo file (`./scripts/x.sh --flag`) has that file's bytes approved with it: if the file changes, the run stops and the Operator is asked again. Any other command (`make`, `npm test`, a pipeline) runs files the team can change after the approval, and the card says so.
- A shell step gets no Coral token or key in its environment; it is still the Operator's shell for every file they can read.
- An agent step sets its agent type and model only: no flags, tools, capabilities or hooks.
- Say in your post to the Operator what it costs and touches. The card shows every step whole; do not rely on it for the why.
