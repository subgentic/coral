---
name: getting-started-agent
description: "How to guide a new user through Coral with a single agent when they request the Getting started tour."
metadata:
  published-by: Coral
  kind: example
---

Guide me through Coral as a first-time user. Lead one small step at a time. Wait for my answer or action before continuing. Use plain words and explain unfamiliar labels. When you ask me something with a few answers, give them as buttons, never as a typed list. Every step that waits on me ends with buttons too, never plain chat like "tell me when you're done": ask with `coral-agent ask "<the one thing to do now>" --option "Done" --option "Skip this step" --option "Stop the tour"` and stop until my answer arrives.

Start with these two lines:
Coral is a workspace where you give AI agents work and follow their progress.
You can answer questions, review files, and guide the work from one place.

Ask what I would like to make using `coral-agent ask "What would you like to make?" --option "A short report" --option "A simple spreadsheet" --option "A project plan"`. Tell me to open Needs you and click one of the buttons, or type my own idea there. Say in one line how to get any agent to do this again: ask it to ask me with buttons, and it will use `coral-agent ask --option`. Stop until my answer arrives. If that command is unavailable, explain that this tour needs a newer Coral and pause.

Create a small sample file related to my answer, using sample information only. Upload it with `coral-agent artifact upload <file> --tag "for review" --question "Does this sample look right?"`. Give me the returned Coral link. Walk me through opening the file, adding a comment, choosing Send to agent, and choosing Approve or Request changes. After each, say in one line how to get any agent to do it again: ask it to put a file in Needs you for review (`coral-agent artifact upload <file> --tag "for review"`), to read my comments, and to answer Send to agent. Explain that Send to agent asks you to respond; it is optional. Tell me the Approve and Request changes buttons are on the file itself (the file's own page, not in this chat), and that I can use them or the buttons you ask with. Respond to my feedback and wait for my review before moving on. When you change a file I reviewed, upload the new copy with `--new-version-of <digest of the earlier upload>` (the last part of its link), never as a separate file, so my comments and what changed stay with it. Say in one line that I can ask any agent to "upload it as a new version" to keep the history.

Point out Analytics for activity and usage, and Settings for preferences. Invite me to open each; after each, ask with the Done / Skip this step / Stop the tour buttons and wait.

Finish by asking what real work I want to start (with `coral-agent ask ... --option` buttons for the likely choices, up to 3). Let me skip or stop the tour at any time.
