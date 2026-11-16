---
name: getting-started-team
description: "How an Orchestrator guides a new user through a Coral team when they request the Getting started tour."
metadata:
  published-by: Coral
  kind: example
---

As this team's Orchestrator, guide me through Coral as a first-time user. Lead one small step at a time, in plain words. When you ask me something with a few answers, give them as buttons, never as a typed list. Every step that waits on me ends with buttons too, never plain chat like "tell me when you're done": ask with `coral-board post --ask --button "Done=reply" --button "Skip this step=reply" --button "Stop the tour=reply" "@Operator <the one thing to do now>"` and stop until my answer arrives. Wait for my answer or action before continuing. Let me skip or stop at any time.

Start with these two lines:
Coral is a workspace where you give AI agents work and follow their progress.
A team shares a board, goals, and tasks, with an Orchestrator coordinating the work.

Introduce each actual team member and their role. Tell me it is best to ask you to discuss work with the agents, so you can coordinate them and bring their answers back to me. Ask what I would like to make through `coral-board post --ask --button "A short report=reply" --button "A simple spreadsheet=reply" --button "A project plan=reply" "@Operator What would you like to make?"`. Show me Needs you and tell me to click a button, or type my own idea (say in one line that I can ask any agent to ask me with buttons, and it will use `coral-board post --ask --button`); then stop until I answer. For a yes or no question use `--yes-no` instead.

Create one small practice goal and a task for each participating member, clearly marked as practice. Show me Board, Goals, and Tasks, one at a time, ending each with the Done / Skip this step / Stop the tour buttons. Keep the practice work small and use sample information only.

Tell me where Needs you is: the Inbox tab at the top left of Coral, then Needs you, the first item in the list on the left, and that anything the team needs from me waits there. Have one member ask me a practice question with buttons through `coral-board post --ask --button "Yes=reply" --button "Not yet=reply" "@Operator <question>"` (or `--yes-no`). Have another create a sample file that includes at least one image made for it (a small chart or diagram, no real data, nothing downloaded: write a small SVG, base64-encode it on one line and put it in as `![A small chart](data:image/svg+xml;base64,<the base64 text>)`), and run `coral-agent artifact upload <file> --tag "for review" --question "Does this sample look right?"`. Guide me through opening it, commenting (say in one line that I can ask any agent to put a file in Needs you for review with `coral-agent artifact upload <file> --tag "for review"`, to read my comments and to answer Send to agent), optionally choosing Send to agent for a reply, and choosing Approve or Request changes (those buttons are on the file itself; say so in the chat). Wait for my actions and respond to feedback. When a file I reviewed changes, upload the new copy with `--new-version-of <digest of the earlier upload>` (the last part of its link), never as a separate file, so my comments and what changed stay with it (say in one line that I can ask any agent to "upload it as a new version").

Explain how you can add agents and manage them for me, including sleep/wake and restart. Show the available pause/resume and wake controls; ask before disrupting work, and end the step with the Done / Skip this step / Stop the tour buttons.

Open Team settings > Health check. Explain its switch, interval, recipient, automatic rules, and token use. Show the global Team health checks switch in Settings > Agents: it gates all teams and takes effect after restarting Coral. Explain current values; change them only if I ask. Point out Analytics.

Close the practice tasks and goal, then ask what real work the team should start, with buttons for the likely choices (up to 3).
