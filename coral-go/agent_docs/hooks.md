# Hooks

Hooks let you run shell commands at specific points in an agent's lifecycle or workflow step execution. They're defined in Claude Code's settings.json format and work across team agents and workflow steps.

---

## Hook Format

A hooks object maps event names to arrays of hook groups. Each group has an optional `matcher` (tool name filter) and a `hooks` array of commands to run.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "echo 'file modified'" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "curl -X POST https://hooks.example.com/done" }
        ]
      }
    ],
    "StepComplete": [
      {
        "hooks": [
          { "type": "command", "command": "echo 'step finished successfully'" }
        ]
      }
    ]
  }
}
```

---

## Events

### Agent-Native Events

These events fire inside the agent process. Claude Code reads user and Coral hooks from `settings.json` (`internal/agent/claude.go`); Antigravity (`agy`) reads Coral's `coral-hook-agentic-state --agy <event>` hooks (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `Stop`) from `<tmp>/coral_agyhooks_<session>_*/.agents/hooks.json` passed via `--add-dir` (`internal/agent/agy.go`, `cmd/coral-hook-agentic-state/main.go`); Codex receives Coral's `coral-hook-agentic-state` hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) via `-c hooks.<Event>=...` (`internal/agent/codex.go`). User-defined workflow and team `hooks` in `settings.json` format are injected into Claude sessions; for workflow steps on other agent types, `Stop`, `StepComplete`, and `StepFailed` are run by Coral's workflow runner.

| Event | When it fires | Notes |
|-------|---------------|-------|
| `PreToolUse` | Before a tool executes | Native in Claude (`settings.json`), Antigravity (`--add-dir` `.agents/hooks.json`), and Codex (`-c hooks.PreToolUse`); exit code 2 blocks the tool call in Claude |
| `PostToolUse` | After a tool executes | Native in Claude, Antigravity, and Codex via `coral-hook-agentic-state`; use `matcher` to filter by tool name |
| `Stop` | When the agent turn or session stops | Native in Claude, Antigravity, and Codex via `coral-hook-agentic-state`; also fired by Coral's workflow runner after a step process exits |
| `Notification` | On notification events | Claude-only |
| `SubagentStop` | When a subagent completes | Claude-only |

### Coral-Managed Events (all agent types + shell steps)

These events are managed by Coral's workflow runner. They work for all step types (shell, Claude, Antigravity, Codex) and fire after the step process exits.

| Event | When it fires | Notes |
|-------|---------------|-------|
| `StepComplete` | After a step finishes successfully | Works for shell and all agent types |
| `StepFailed` | After a step fails | Works for shell and all agent types |

---

## Event Support by Agent Type

| Event | Claude | Antigravity (agy) | Codex | Shell Steps |
|-------|--------|-------------------|-------|-------------|
| `PreToolUse` | Native | Native (`coral-hook-agentic-state` via `--add-dir`) | Native (`coral-hook-agentic-state` via `-c`) | -- |
| `PostToolUse` | Native | Native (`coral-hook-agentic-state` via `--add-dir`) | Native (`coral-hook-agentic-state` via `-c`) | -- |
| `Stop` | Native | Native (`coral-hook-agentic-state`) / Runner-managed (workflows) | Native (`coral-hook-agentic-state`) / Runner-managed (workflows) | -- |
| `Notification` | Native | -- | -- | -- |
| `SubagentStop` | Native | -- | -- | -- |
| `StepComplete` | Runner-managed | Runner-managed | Runner-managed | Runner-managed |
| `StepFailed` | Runner-managed | Runner-managed | Runner-managed | Runner-managed |

**Native** means the agent CLI fires the hook inside its own lifecycle (for Antigravity, Coral writes `<tmp>/coral_agyhooks_<session>_*/.agents/hooks.json` and passes `--add-dir`, `internal/agent/agy.go`; for Codex, Coral passes `-c hooks.<Event>=...`, `internal/agent/codex.go`; user-defined `hooks` in team/workflow configs are injected into Claude's `settings.json`).
**Runner-managed** means Coral's workflow runner executes the hook command after the step process exits.

---

## Using Hooks in Workflows

Add a `hooks` field to any step definition. The runner routes events based on step type and agent type.

```json
{
  "name": "build-and-notify",
  "steps": [
    {
      "name": "test",
      "type": "shell",
      "command": "go test ./...",
      "hooks": {
        "StepFailed": [
          {
            "hooks": [
              { "type": "command", "command": "curl -X POST $SLACK_WEBHOOK -d '{\"text\": \"Tests failed\"}'" }
            ]
          }
        ]
      }
    },
    {
      "name": "fix",
      "type": "agent",
      "prompt": "Fix the failing tests.",
      "agent": { "agent_type": "claude" },
      "hooks": {
        "PostToolUse": [
          {
            "matcher": "Edit|Write",
            "hooks": [
              { "type": "command", "command": "echo 'file changed'" }
            ]
          }
        ],
        "StepComplete": [
          {
            "hooks": [
              { "type": "command", "command": "curl -X POST $SLACK_WEBHOOK -d '{\"text\": \"Fix applied\"}'" }
            ]
          }
        ]
      }
    }
  ]
}
```

### Environment Variables

All hooks have access to these environment variables:

| Variable | Description |
|----------|-------------|
| `CORAL_WORKFLOW_NAME` | Workflow name |
| `CORAL_WORKFLOW_RUN_ID` | Run ID |
| `CORAL_WORKFLOW_STEP` | Current step index (0-based) |
| `CORAL_WORKFLOW_STEP_DIR` | Step artifact directory path |
| `CORAL_WORKFLOW_RUN_DIR` | Run artifact directory path |
| `CORAL_WORKFLOW_REPO_PATH` | Workflow repo path |
| `CORAL_STEP_STATUS` | Step outcome: `completed` or `failed` (StepComplete/StepFailed only) |

---

## Using Hooks in Team Agents

Hooks can be set at the team defaults level (apply to all agents) or per-agent.

```json
{
  "name": "monitored-team",
  "working_dir": "/home/user/project",
  "defaults": {
    "hooks": {
      "Stop": [
        {
          "hooks": [
            { "type": "command", "command": "notify-team 'agent stopped'" }
          ]
        }
      ]
    }
  },
  "agents": [
    {
      "name": "Orchestrator",
      "role": "orchestrator",
      "hooks": {
        "PostToolUse": [
          {
            "matcher": "Bash",
            "hooks": [
              { "type": "command", "command": "log-command-usage" }
            ]
          }
        ]
      }
    },
    {
      "name": "Developer",
      "prompt": "Implement features."
    }
  ]
}
```

The Orchestrator gets both the global `Stop` hook and its own `PostToolUse` hook (merged). The Developer gets only the global `Stop` hook.

### Merge Rules

- **Defaults + agent**: Agent hooks are **appended** per event (both fire)
- **Workflow default_agent + step**: Step hooks **replace** the default (only step hooks fire)
- **Coral system hooks**: Always injected, cannot be overridden

---

## Using Hooks in the Launch API

Pass hooks when launching a single agent session:

```bash
# a script you run yourself, never an agent
curl -H "Authorization: Bearer $(coral api-key)" -X POST http://localhost:8420/api/sessions/launch \
  -H "Content-Type: application/json" \
  -d '{
    "working_dir": "/home/user/project",
    "agent_type": "claude",
    "hooks": {
      "Stop": [
        {
          "hooks": [
            { "type": "command", "command": "echo agent stopped" }
          ]
        }
      ]
    }
  }'
```

---

## Coral System Hooks

Coral automatically injects system hooks into agent sessions so the dashboard tracks tool calls, turn boundaries, and state. They cannot be removed or overridden by user-defined hooks.

The hook programs come from the folder Coral puts first on the agent's PATH: `CORAL_HOOK_DIR` when set, else next to the `coral` binary (the installed app's own folder for a release install). A dev or test server never falls back to the installed app's; its startup log names the folder (see Troubleshooting).

| Hook | Agent Types | Events | Purpose |
|------|-------------|--------|---------|
| `coral-hook-task-sync` | Claude | `PostToolUse` (`TaskCreate\|TaskUpdate`) | Syncs task changes to Coral |
| `coral-hook-agentic-state` | Claude, Antigravity (`agy`), Codex | Claude: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Elicitation`, `ElicitationResult`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`<br>Antigravity (`--agy <event>` in `<tmp>/coral_agyhooks_<session>_*/.agents/hooks.json` via `--add-dir`, `internal/agent/agy.go`): `SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `Stop`<br>Codex (`-c hooks.<Event>=...`, `internal/agent/codex.go`): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` | Updates agent state, pending tools, model (`modelName` on `agy`), and activity timeline in Coral UI (`cmd/coral-hook-agentic-state/main.go`) |
| `coral-hook-message-check` | Claude | `PostToolUse` | Checks for new board messages |

### Codex: trusting Coral's hooks

Codex gets `coral-hook-agentic-state` for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop on its command line (`-c hooks.<Event>=...`). Codex 0.161 and later runs a hook only after the person trusts it: until then a new agent opens on **Hooks need review** (1. Review hooks / 2. Trust all and continue / 3. Continue without trusting), and Coral gets no hook events from it.

With the setting **Skip Codex's review of Coral's hooks** on (the default), Coral gives that trust itself, for each Codex it launches. It passes `-c hooks.state={...}` with a `trusted_hash` for exactly the five hook entries it passes, computed the way Codex computes it, so Codex starts without the dialog. It never writes the person's `CODEX_HOME`, and it never uses Codex's `--dangerously-bypass-hook-trust`. Every other hook Codex loads (your own, a repository's `.codex` hooks, a plugin's) still asks.

It does that only on Windows, and only while nobody but SYSTEM, Administrators or TrustedInstaller can change the hook tool or its folder: an installed Coral under Program Files. In a portable or dev build anything running as you, another agent included, could replace a hook program that Codex would then run outside its sandbox, so there Codex keeps asking. On macOS and Linux an app folder is owned by its user, so no check can tell an installed Coral from one you can change, and Codex keeps asking there too. A Codex version that hashes hooks differently makes the trust not match, and Codex asks again.

The setting can only be changed on this computer: in Settings, which also shows whether the trust applies now and why not, or with `PUT /api/system/codex-trust-hooks {"trust": bool}` from the dashboard or the signed command line. `GET` on the same route reads it. Neither `PUT /api/settings` nor Coral Hub can change it. It applies to Codex agents launched after the change.

---

## Validation Rules

When creating or updating workflows, hooks are validated:

1. Event names must be one of: `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `SubagentStop`, `StepComplete`, `StepFailed`
2. Each event value must be an array of hook groups
3. Each hook group must contain a `hooks` array with at least one entry
4. Each hook entry must have `type: "command"` and a non-empty `command`
5. `matcher` is optional (pipe-separated tool names, e.g. `"Edit|Write"`)
6. Max 10 hook groups per event
7. Max 50 total hook groups across all events

### Agent-Type Warnings

Configuring Claude-only events (`PreToolUse`, `PostToolUse`, `Notification`, `SubagentStop`) on non-Claude agent steps produces a validation warning but does not block creation.

---

## Execution Details

- **Timeout**: Each hook command has a 60-second execution timeout (matches Claude Code's default)
- **Best-effort**: Hook failures are logged but do not fail the step
- **Hook commands** run in a `sh -c` subshell with the step's environment variables
- **Order**: Hooks within a group fire sequentially; multiple groups fire in array order
