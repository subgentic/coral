# Chief: a user guide

Chief is the one agent you talk to. It sits in front of your dev team: you tell Chief what you want, Chief takes the request to the team's Orchestrator, and the team's answer comes back to you in plain words. You can do all of it from your phone. (This page is for the person using Chief. The agent's own instructions are in [chief.md](chief.md).)

## What Chief does, and does not do

- **It relays.** It sends your request to the dev team's Orchestrator, labelled as a relay ("Chief relays the Operator's request: ..."), and tells you what the team says back, starting "The dev team says:".
- **It asks you for decisions.** An approval, a question or a permission is asked in Chief's chat as a real question, so it also shows in your Inbox under Needs you.
- **It says what it is waiting for** if you ask.
- **It does not do the work.** It does not edit files or run commands for the dev team; the team does that.
- **It does not grant things for you.** Only you approve a permission, change a setting or turn on a permissive mode. If the dev team asks for one, Chief asks you and waits for your answer.
- **It never says you approved something you did not.** A relayed line is always marked as a relay.

## Set it up: Settings > Chief

Chief's screen is in Settings, on this computer only (it is not available through Coral Hub).

1. **Start the agent** that will be Chief, on a team of its own (a team of one). Any running agent can be picked; it is the agent you chose that is Chief, never a team an agent made.
2. Open **Settings > Chief** and fill in:
   - **Name** and **Avatar** (one of eight colours and one letter): they show on the Chief page and in its chat.
   - **Which agent**: the running agent that is Chief. The model it runs is shown, with a link to change it on the agent's own page.
   - **Chief's actions**: *Ask first* (Chief asks before each action; the default) or *Act* (Chief edits without asking; a shell command still asks). It applies when Chief restarts.
   - **Team it fronts**: the dev team whose Orchestrator Chief takes your requests to.
   - **Serve the Chief page**: turns on the phone page.
3. Save. The name and avatar appear at once.

If your Coral restricts messages between teams (the `cross_team_allowlist` setting, see [cross-team.md](cross-team.md)), the dev team's board must allow Chief's team as a sender before a relay is accepted.

## The Chief page (`/chief`)

`/chief` is a page for your phone with nothing of the rest of the app around it: Chief's chat, the message box and the question or approval Chief is asking. It is behind the normal sign-in like the rest of Coral. It answers only while **Serve the Chief page** is on; with it off the address shows "not found". If no agent has been picked yet, the page says so.

## How a request travels

1. You write to Chief in its chat (on `/chief`, or in the app).
2. Chief sends it to the dev team's Orchestrator with `coral-board send --board <team>`, marked as a relay.
3. The Orchestrator and the team work on it.
4. The Orchestrator's reply reaches Chief as a message from `Orchestrator (<team>)`; Chief tells you in a few lines.
5. Anything that needs **you** (a decision, an approval of a file, a permission) is asked as a question in Chief's chat and appears in **Needs you**; answer it there or in the chat. Files the team wants reviewed are Needs you rows of their own: open one to read it, then Approve or Request changes.

## Tips

- Name the dev team once ("the dev team is `coral-go-team`"); Chief asks if it does not know.
- Ask "what are you waiting for?" any time: Chief says what it has sent and what has not been answered, and does not guess.
- Long reports arrive as a file (a `coral://artifacts/...` link) rather than in the chat.
- To stop using Chief, turn **Serve the Chief page** off; the agent keeps running as any other agent.
