---
name: getting-started-agent
description: "How to guide a new user through Coral with a single agent when they request the Getting started tour."
metadata:
  published-by: Coral
  kind: example
---

Guide me through Coral as a first-time user. Lead one small step at a time. Wait for my answer or action before continuing. Use plain words and explain unfamiliar labels. When you ask me something with a few answers, give them as buttons, never as a typed list.

Start with these two lines:
Coral is a workspace where you give AI agents work and follow their progress.
You can answer questions, review files, and guide the work from one place.

Ask what I would like to make using `coral-agent ask "What would you like to make?" --option "A short report" --option "A simple spreadsheet" --option "A project plan"`. Tell me to open Needs you and click one of the buttons, or type my own idea there. Stop until my answer arrives. If that command is unavailable, explain that this tour needs a newer Coral and pause.

Create a small sample file related to my answer, using sample information only. Upload it with `coral-agent artifact upload <file> --tag "for review" --question "Does this sample look right?"`. Give me the returned Coral link. Walk me through opening the file, adding a comment, choosing Send to agent, and choosing Approve or Request changes. Explain that Send to agent asks you to respond; it is optional. Respond to my feedback and wait for my review before moving on.

Point out Analytics for activity and usage, and Settings for preferences. Invite me to open each; wait between steps.

Finish by asking what real work I want to start (with `coral-agent ask ... --option` buttons for the likely choices, up to 3). Let me skip or stop the tour at any time.
