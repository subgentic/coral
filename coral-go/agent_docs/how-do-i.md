# How do I...?

> Short click-by-click answers to the things people ask first.

Each answer names the button as it reads on screen. The topics after this one go deeper.

## Add a team member

1. In the **Agents** list, click the team's name to open its page.
2. Click **Add agent** (top right of the team's page). The same item is in the **⋯** menu beside the team's name, as **Add Agent**.
3. The dialog already knows the team and its folder. Pick a persona (or skip it), choose the agent, then press **Launch**. The new agent joins the team's message board.

## Change the default model

1. Click the gear at the top right to open **Settings**, then **Agents**.
2. Under **Default models**, pick a model for each agent type, or **Other…** to type any model id.
3. Press **Save settings**.

New agents use it unless you choose a model when you launch them.

## Switch to the light theme

1. Click the gear at the top right to open **Settings**. **General** is the first group.
2. Next to **Theme**, pick **Light**. **System** follows your computer instead, and **Customize Theme** beside it makes your own.
3. Press **Save settings**.

## Copy a chat, or keep part of it

- **Copy one reply:** point at an agent's reply and press **Copy message**. It copies the reply as the agent wrote it.
- **Copy a message you sent:** open the **⋯** beside it and choose **Copy**. The same menu has **Save for later**.
- **A whole team's messages:** on the team's message board, press the select button in its header, choose the messages and press **Export Markdown**.
- **A single chat has no export button yet.** Its **Summary** tab (open the chat from **Inbox**, then **All chats**) says what was done.

## Find an old chat

1. Open the **Inbox**, then **All chats**. Every chat Coral has read is listed there.
2. Type words you remember in **Search chats** at the top of the list. Press **Star** on a chat you will want again: it is in the **Starred** folder after that.
3. Typing in the Agents list's search offers **Search all chats** for the same words.

## Continue an old chat

1. Open the **Inbox**, then **All chats**, and find the chat (the answer above, Find an old chat, says how).
2. Press **Continue this chat**: the round play button at the end of the chat's row, or the **Continue this chat** button on the chat's own page. The chat opens first.
3. The **Resume session** dialog asks which **Working Directory** to start in. It fills in the folder the chat ran in, and says so under the box. Keep it, or press **Browse** to pick another folder and **Use this folder**: the dialog warns that the files the chat was using may not be found there. **Resume in** picks how much the agent may do without asking (the last answer on this page lists each one): the chat keeps what it ran with, the note under the folder says which, and you can pick another or the saved default. If the chat belonged to a team, **Rejoin board** puts the agent back on its message board.
4. Press **Resume**. A live agent starts in that folder and picks the conversation up where it stopped; the old chat stays as it was.

## Give an agent a file

- **A file in its folder:** in the message box, type **@** and the start of the file's name. A list of the files in the agent's folder opens; pick one and its path is put in your message, so the agent knows which file you mean. In a folder with many files, keep typing to narrow the list.
- **A picture:** press the picture button in the corner of the message box (**Attach an image**), or paste an image into the box. On a phone the button offers the Photo Library, Take Photo and Browse. A small chip shows the picture before you send. The agent is given a link to it, not your computer's path.
- A sleeping agent cannot be given anything: **Wake** it first.

## What the permission modes allow

**Default permission mode** in **Settings**, **Agents** is the mode new agents start in. You can also pick a mode for one agent when you launch it. One line each:

- **Default:** asks before acting. Each CLI's own normal mode. For Codex it asks before every action and cannot reach Coral from its sandbox, so use Auto for a team member.
- **Plan:** reads only. Best for exploring a codebase before changing it.
- **Accept edits:** reads, edits files and runs common file commands (mkdir, touch, mv, cp). Best for iterating on code you are reviewing. Codex does not have it.
- **Auto:** everything, but what that means depends on the CLI. **Claude** checks each action for safety. **Codex** runs in a workspace sandbox that never asks, with the network on. **Antigravity** and **Gemini** have no prompts and no safety checks. **Pi** has no permission prompts at all: it always acts on its own.
- **Bypass permissions:** everything except protected paths, with the safety checks off. Only for isolated containers and virtual machines. On **Antigravity**, **Gemini** and **Pi** it means what Auto means there: no prompts and no safety checks (Pi always acts on its own).
- **Don't ask:** only tools you approved ahead of time. Best for locked-down CI and scripts. Codex does not have it: its Auto is the same launch. On **Antigravity**, **Gemini** and **Pi** it means what Auto means there: no prompts and no safety checks (Pi always acts on its own).

**Not set** starts a new agent in Auto and a new team member in Default. With such a default, an orchestrator's launches of other agents are refused until you pick Default or start them yourself.

## Open Coral on your phone

1. On Home, click **Mobile QR code** (at the bottom of the page). The **Use on your phone** dialog opens.
2. If it says mobile access is off, press **Enable**. That lets devices on your network reach Coral; they need your password or a setup code. Or press **Use Coral Hub instead**, which needs no network access.
3. Once it is on, the dialog shows a QR code and an address. Scan the code with your phone, or press **Copy** and send yourself the link.
4. Your phone must be on the same network as this computer. The first time, it asks for the setup code on the sign-in page: press **Show setup code** here and type it in.

## Put a team's agents to sleep, and stop an agent

- **Sleep a whole team:** open the **⋯** menu beside the team's name and choose **Sleep Team**. Its agents stop running; their chats stay. **Wake Team** (the same place) starts them again.
- **Pause one agent:** open the **⋯** menu on its row and choose **Sleep**. It stops running and its chat stays; **Wake** (the same place) starts it again.
- **Put one away:** choose **Archive**. It leaves the list and its chat is kept; **Unarchive** brings it back.
- **Stop one for good:** choose **Kill Session**. The agent ends now and its running work is lost.
- **Stop a reply that is still running:** while the agent is working and the message box is empty, the **Esc** button beside the box turns red and says **Stop**: press it, or press **Escape** in the empty message box. On a phone the round Send button becomes a red square named **Stop the agent**. The agent stops what it is doing and its chat stays.

## Next

- [Quickstart](quickstart.md) — install, start the server and launch your first agent.
- [Using the dashboard](using-the-dashboard.md) — models, the agent list, the Inbox.

## Still stuck?

- [Troubleshooting](troubleshooting.md) — when something does not start or does not look right.
- [Forum](https://github.com/subgentic/coral/discussions) — ask a question, or see what others asked.
- [GitHub](https://github.com/subgentic/coral) — report a problem.
