# How do I...?

> Short click-by-click answers to the things people ask first.

Each answer names the button as it reads on screen. The topics after this one go deeper.

## Add a team member

1. In the **Agents** list, click the team's name to open its page.
2. Click **Add agent** (top right of the team's page). The same item is in the **⋯** menu beside the team's name, as **Add Agent**.
3. The dialog already knows the team and its folder. Pick a persona (or skip it), choose the agent, then press **Launch**. The new agent joins the team's message board.

## Give the team a second goal

1. In the **Agents** list, click the team's name to open its page, then open its **Goals** tab.
2. Click **New goal**.
3. Name the goal, say what should be true when it is done, and add a **Done when** line (one thing you can check). Choose the agent who looks after it under **Driver**.
4. Press **Create goal**. The team works on both goals; each goal page shows its own tasks and files.

## Change the default model

1. Click the gear at the top right to open **Settings**, then **Agents**.
2. Under **Default models**, pick a model for each agent type, or **Other…** to type any model id.
3. Press **Save settings**.

New agents use it unless you choose a model when you launch them.

## Switch to the light theme

1. Click the gear at the top right to open **Settings**. **General** is the first group.
2. Next to **Theme**, pick **Light**. **System** follows your computer instead, and **Customize theme** beside it makes your own.
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
3. The **Resume session** dialog asks which **Working directory** to start in. It fills in the folder the chat ran in, and says so under the box. Keep it, or press **Browse** to pick another folder and **Use this folder**: the dialog warns that the files the chat was using may not be found there. **Resume in** picks how much the agent may do without asking (the last answer on this page lists each one): the chat keeps what it ran with, the note under the folder says which, and you can pick another or the saved default. If the chat belonged to a team, **Rejoin board** puts the agent back on its message board.
4. Press **Resume**. A live agent starts in that folder and picks the conversation up where it stopped; the old chat stays as it was.

## Get an agent to put something in front of you

Agents put what needs you (a decision, an approval, a file to look at) in your **Inbox**, under **Needs you**. An agent asks with `coral-board post --ask "@Operator <question>"`, or uploads the file tagged **for review**, and only for what you must see, decide or approve (logs, patches, notes and screenshots meant for other agents are not tagged, so Needs you does not fill up): one item per decision, with its recommendation. Your comments on a **for review** file reach the agent that uploaded it whether you make them at this computer's dashboard or through Coral Hub; on a team machine they are not delivered (several people share one issuer). It does not publish the team's work outside Coral without your OK. Every team's agents are told this by default; you do not need to add it to the team's instructions.

## Give an agent a file

- **A file in its folder:** in the message box, type **@** and the start of the file's name. A list of the files in the agent's folder opens; pick one and its path is put in your message, so the agent knows which file you mean. In a folder with many files, keep typing to narrow the list.
- **A picture:** press the picture button in the corner of the message box (**Attach an image**), or paste an image into the box. On a phone the button offers the Photo Library, Take Photo and Browse. A small chip shows the picture before you send. The agent is given a link to it, not your computer's path.
- A sleeping agent cannot be given anything: **Wake** it first.

## What the permission modes allow

**Default permission mode** in **Settings**, **Agents** is the mode new agents start in. You can also pick a mode for one agent when you launch it. One line each:

- **Default:** asks before acting. Each CLI's own normal mode. For Codex it asks before every action and cannot reach Coral from its sandbox, so use Auto for a team member.
- **Plan:** reads only. Best for exploring a codebase before changing it.
- **Accept edits:** reads, edits files and runs common file commands (mkdir, touch, mv, cp). Best for iterating on code you are reviewing. Codex does not have it.
- **Auto:** everything, but what that means depends on the CLI. **Claude** checks each action for safety. **Codex** runs in a workspace sandbox that never asks, with the network on. **Antigravity** and **Gemini** run agy in its own auto mode (`--mode auto`), the default for them; an agy that does not offer that mode asks as usual, and Coral never swaps in the flag that skips every prompt. **Pi** has no permission prompts at all: it always acts on its own.
- **Bypass permissions:** everything except protected paths, with the safety checks off. Only for isolated containers and virtual machines. On **Antigravity** and **Gemini** it starts agy with its flag that skips every prompt, with no safety checks. On **Pi** and **opencode** it means what Auto means there: no prompts and no safety checks (Pi always acts on its own; opencode edits files and runs commands in its folder without asking, and asks only before something outside it).
- **Don't ask:** only tools you approved ahead of time. Best for locked-down CI and scripts. Codex does not have it: its Auto is the same launch. On **Antigravity** and **Gemini** it starts in Plan (read-only, `--mode plan`), because agy has no mode that approves only what you allowed ahead of time. On **Pi** and **opencode** it means what Auto means there: no prompts and no safety checks (Pi always acts on its own; opencode edits files and runs commands in its folder without asking, and asks only before something outside it).
- **When an agent starts an agent:** it cannot start one that can do more without asking than itself. Coral refuses with a 403 whose message says so ("an agent cannot start a ... agent that can do more without asking than itself ... ask the Operator to start it"), and a member it starts without a mode starts in the default mode capped to the starting agent's own. The Operator, from the dashboard, the command line or an API key, keeps every choice.
- **A launch that names no mode:** from the dashboard, the command line or an automation it starts in the default: Auto for Claude, Codex, Antigravity and Gemini, no prompts for Hermes and opencode (Bypass: Hermes by the Operator's decision, with no sandbox of any kind; opencode asks nothing inside its folder), and Pi never asks; from an agent it starts at that agent's own level; through Coral Hub it starts in Default. A team launch through Coral Hub that would start a member in Auto is refused with a 403 unless the owner has turned on Coral Hub's auto-accept switch and set the Launch mode (code `hub_mode_too_low`, or `no_dashboard_provenance` for a request that did not really come from the Hub).

**The first-launch notice.** Until you have read it, the dashboard on this computer shows a notice under the top bar: *Agents default to auto mode: they can act without asking you; protections vary by agent.* Open it to read the rest (*Agents default to auto mode. Choose a different permission mode when you launch an agent or set a default in Settings.*) and press **I've read this**, or press **Dismiss** without opening it: both count as read. **Settings > Agents** keeps the same words under **Permissions notice**, next to the default mode. If you launch from the New agent dialog in a mode that skips prompts before you have read it, Coral stops with *Before starting in auto mode* and the notice: **Continue launch** records it as read and goes on, and **Cancel** starts nothing. A launch that names its mode, and one from the command line or the API, goes on, and its answer carries the notice and a sentence on how to lower the mode. Only you can read or answer the notice: an agent is refused with a 403. Coral Hub's dashboard does not show it.

**opencode** needs `lsof` or `ss` (`netstat` on Windows) on the machine: Coral uses it to check that the program on the server's port is the one it started before it sends the server its password. A machine without them cannot start an opencode agent.

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
- **Stop one for good:** choose **Stop agent**. The agent ends now and its running work is lost.
- **Take a sleeping or archived one off the list:** choose **Remove Agent** in its menu. Nothing is running, so nothing is lost; its chat stays in History.
- **Stop a reply that is still running:** while the agent is working and the message box is empty, the **Esc** button beside the box turns red and says **Stop**: press it, or press **Escape** in the empty message box. On a phone the round Send button becomes a red square named **Stop the agent**. The agent stops what it is doing and its chat stays.

## Next

- [Quickstart](quickstart.md) — install, start the server and launch your first agent.
- [Using the dashboard](using-the-dashboard.md) — models, the agent list, the Inbox.

## Still stuck?

- [Troubleshooting](troubleshooting.md) — when something does not start or does not look right.
- [Forum](https://github.com/subgentic/coral/discussions) — ask a question, or see what others asked.
- [GitHub](https://github.com/subgentic/coral) — report a problem.
