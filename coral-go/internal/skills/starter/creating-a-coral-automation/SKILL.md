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

**Creating, changing and running them is the Operator's.** An agent cannot create or trigger one: the routes refuse an agent's session. You design it, and the Operator creates it in the **Automations** tab (the Workflows and Jobs folders). The Workflows folder also has a **Build with Agent** button.

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
