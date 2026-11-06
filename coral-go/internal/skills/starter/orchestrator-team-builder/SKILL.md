---
name: orchestrator-team-builder
description: "How a board's Orchestrator builds a team for a person: they describe the personas they want, you ground each one in their project, put the team in a draft review file, and launch only what they approve."
metadata:
  published-by: Coral
  kind: example
---

# Building a team for a person

Use this when you are the board's Orchestrator and a person wants a team. The person describes who they want; you turn that into specific agents for their project; they approve a draft file; only then do you launch.

## 1. Ask (one message, numbered, then wait)

1. Who do you want on the team? Describe each teammate in your own words: what they are good at, what they care about ("a careful backend developer", "a reviewer who distrusts shortcuts", "a designer who loves dark themes"). If unsure, offer: one worker and one reviewer.
2. The goal, in one sentence, and what done looks like.
3. The repo or folder. Check the path exists yourself.
4. Risk: anything touching production, money or secrets? Must a person review before it lands?
5. The most agents they want, and any time or spend limit.

If an answer is missing, say what you will assume and carry on. Keep the team small: default to three (you, a worker, a reviewer), and never plan more than the person's number or the board's limit (a new team starts with room for five agents besides you, counting those already running; the Operator can change it).

## 2. Learn the project (read only)

Before writing a prompt, read what the agents will face: the README, the manifest (`package.json`, `go.mod`, `pyproject.toml`), the exact test and build commands, the top-level layout and `git status`. Change nothing and run nothing that writes. The prompts must use these real facts.

## 3. Expand each persona

For each teammate write a name, a role in one line, and a prompt of about twelve lines that fits this project:

- Who they are: the persona in the person's words, turned into how they work and what they check.
- The goal and what done looks like; the folder; the commands they run (test, build, lint) written out.
- What they must not touch, and when to stop and ask.
- "You are already joined to the board: do not run `coral-board join`, do not poll `coral-board read`, wait for the Orchestrator's assignment."
- "Report what you ran and what you did not run."
- A reviewer reads and posts findings; it does not edit.

Do not choose an agent type, a model or a thinking level: launches use the person's saved defaults for all three, and you name a type or model only when the person asks for one (the launch command has no thinking flag).

## 4. Draft for approval

Write one Markdown file, `team-plan.md`: the goal, done-when, folder, a table (name, role, what it does), a note that every agent starts **ask-first** (it asks before it runs a command or changes a file, and you cannot loosen that), then each agent's full prompt under its name. Upload it for review and stop:

```sh
coral-agent artifact upload team-plan.md --name "Team plan: <name>" --tag "for review" --question "Launch this team of N? Approve to start."
coral-board wait --reason "team plan review" --timeout 30m
```

Coral wakes you when they approve or comment (an approval and a comment each reach you as a board message). A denial may not wake you, so the wait has a timeout: when you wake for any reason, run `coral-board read` first and act on what it says:

- **Approved:** launch exactly the approved prompts (a short note with the approval: apply it if small; do not send the file again).
- **Changes requested** (their comments reach you as board messages): edit the file, upload it with `--new-version-of <the newest link>`, wait again.
- **Denied:** do not launch; ask what they want instead.

Never launch before an approval.

## 5. Launch

One agent at a time. The prompt goes in a shell variable so quotes and line breaks survive.

```sh
coral-board status --json          # the "board" line is your board's id: use it below as <board id>
PROMPT=$(cat <<'P'
You are Reviewer. Goal: ...
P
)
coral-agent launch /path/to/folder --name "Reviewer" --prompt "$PROMPT" --board <board id>
```

It prints `Launched Reviewer (<type>) in <folder>` and a session id; the type is the person's default. Add `--type T` or `--model M` only if they asked for one. Check with `coral-board status --json` that the agent is on the board, then post one line to the person naming who is running.

If a launch is refused, stop and tell the person the server's words, not your own. Known ones:

- `this board already has N live agents: put some to sleep, or ask the Operator to raise the limit in the team's settings (Orchestrator access)`: offer fewer agents, or putting one to sleep with `coral-board sleep "<agent>"`, or asking the Operator to raise the limit there.
- `this board's limit of N launches and wakes an hour is used up`: wait, or ask the Operator to raise it in the team's settings (Orchestrator access).
- Setting off or any other refusal: quote it and say who can change it; do not retry in another way.
- `unsupported agent_type`: use one of the types it lists.

On Windows an agent CLI installed as a `.cmd` file cannot take a board launch yet (#489): say so, and ask the person to start that agent from Coral's New agent button.

## 6. After launching

Wait for the agents to come online, then post the first assignments as tasks (`coral-board task add`), one per agent, and tell the person where to watch: the Agents tab shows each agent, Needs you shows what waits on them. Every launch is logged and said on the board.

The person can also build a team without you: Agents, New team, describe it.
