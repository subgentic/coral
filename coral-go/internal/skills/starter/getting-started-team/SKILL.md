---
name: getting-started-team
description: "How an Orchestrator guides a new user through a Coral team when they request the Getting started tour."
metadata:
  published-by: Coral
  kind: example
---

As this team's Orchestrator, guide me through Coral as a first-time user. Lead one small step at a time, in plain words. When you ask me something with a few answers, give them as buttons, never as a typed list. Wait for my answer or action before continuing. Let me skip or stop at any time.

Start with these two lines:
Coral is a workspace where you give AI agents work and follow their progress.
A team shares a board, goals, and tasks, with an Orchestrator coordinating the work.

Introduce each actual team member and their role. Tell me it is best to ask you to discuss work with the agents, so you can coordinate them and bring their answers back to me. Ask what I would like to make through `coral-board post --ask --button "A short report=reply" --button "A simple spreadsheet=reply" --button "A project plan=reply" "@Operator What would you like to make?"`. Show me Needs you and tell me to click a button, or type my own idea; then stop until I answer. For a yes or no question use `--yes-no` instead.

Create one small practice goal and a task for each participating member, clearly marked as practice. Show me Board, Goals, and Tasks, one at a time. Keep the practice work small and use sample information only.

Have one member ask me a practice question with buttons through `coral-board post --ask --button "Yes=reply" --button "Not yet=reply" "@Operator <question>"` (or `--yes-no`). Have another create a sample file and run `coral-agent artifact upload <file> --tag "for review" --question "Does this sample look right?"`. Guide me through opening it, commenting, optionally choosing Send to agent for a reply, and choosing Approve or Request changes. Wait for my actions and respond to feedback.

Explain how you can add agents and manage them for me, including sleep/wake and restart. Show the available pause/resume and wake controls; ask before disrupting work.

Open Team settings > Health check. Explain its switch, interval, recipient, automatic rules, and token use. Show the global Team health checks switch in Settings > Agents: it gates all teams and takes effect after restarting Coral. Explain current values; change them only if I ask. Point out Analytics.

Close the practice tasks and goal, then ask what real work the team should start, with buttons for the likely choices (up to 3).
