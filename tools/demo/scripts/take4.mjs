import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { OPEN, key, chromium, beat, launchTeam, sleep, agent, askPermission, askQuestion, BASE, S, SEED, REPO, HERE, story } from "./lib.mjs"
process.env.CORAL_TELEMETRY_DISABLED = "1"
// Demo film v4. Beats are recorded (c1..c10); steps are not (world, chats, usage). Order of a run (see ../README.md):
//   NOLAUNCH=1 rig-up.sh; node take4.mjs c1; node take4.mjs launch world chats; python3 -I seed-usage.py; node take4.mjs c2 c3 c4 c5 c6 c7 c8 c9 c10
const which = process.argv.slice(2)
const browser = await chromium.launch({ headless: true })
const out = {}
const { live, inbox, diffAgent, history, goalTasks, goalComment, chats } = story
const uploadOf = (r) => JSON.parse(r.split("\n").find((l) => l.startsWith("{")))
const changed = Object.keys(story.repo.change)
const sid = (name) => JSON.parse(fs.readFileSync(S + "/work/launch.json", "utf8")).agents.find((a) => a.name === name).session_id
const board = (...a) => agent("Orchestrator", "coral-board", ...a)
const goalId = (title) => JSON.parse(board("goal", "list", "--state", "all", "--json")).find((g) => g.title === title)?.id
const taskOf = (title) => JSON.parse(board("task", "list", "--json")).find((x) => x.title === title)
const taskId = (title) => JSON.parse(board("task", "list", "--json")).find((x) => x.title === title)?.id
const WORKERS = ["Backend", "Frontend", "Designer", "Reviewer"]
// add one task to a goal and bring it to a state: completed (done by a worker), in_progress (claimed), pending (left open)
let inProg = 0
const claims = []   // in-progress claims wait until every finished task is done: an agent holds one current task at a time
function addTask(gid, title, state, n) {
  const who = state === "in_progress" ? WORKERS[inProg++ % WORKERS.length] : WORKERS[n % WORKERS.length]
  board("task", "add", title, "--goal", String(gid), "--assignee", who)
  execFileSync("sleep", ["0.8"])   // the assignment reaches the agent first
  const id = taskId(title)
  const tryAs = (...a) => { try { agent(who, "coral-board", ...a) } catch (e) { console.error('  step failed for #' + id + ' ' + who + ': ' + a.slice(0, 2).join(' ')) } }
  if (state === "completed") { tryAs("task", "claim", String(id)); tryAs("task", "complete", String(id), "--message", "Done.") }
  else if (state === "in_progress") claims.push([who, id])
  return id
}
const flushClaims = () => { for (const [who, id] of claims.splice(0)) { try { agent(who, "coral-board", "task", "claim", String(id)) } catch (e) { /* already current */ } } }
// a click that does not wait for the element to hold still (a few panels re-render while the page polls): move to it, then press where it is
const pclick = async (t, loc) => { await t.move(loc); await loc.evaluate((el) => el.click()) }   // the goal panel's buttons do not take a pointer press in a recording; the page's own click does
// type into a box by growing its value with the page's own input events: keys sent to some panels' boxes do not land in them in a recording
const typeInto = async (t, box, text, ms = 22) => { await t.move(box); for (const ch of text) { await box.evaluate((el, c) => { el.value += c; el.dispatchEvent(new Event("input", { bubbles: true })) }, ch); await sleep(ms) } }
// The terminal is drawn on a canvas, so the on-screen text scan cannot read it: read the pane's text from the server and scan it with the same patterns plus the mock's own giveaways.
async function termCheck(name) {
  const r = await fetch(BASE + "/api/sessions/live/claude-" + sid(name) + "/capture", { headers: { Authorization: "Bearer " + key() } })
  const text = await r.text()
  const bad = [/\/tmp\//, /\/private\/var\//, /session_id/i, /\bport=\d+/, /\bboard=/, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /\bb-[a-z0-9]{8,}\b/, /\b[0-9a-f]{32,}\b/i, /coral:\/\//, /\/Users\//, /scratchpad/]
  const hit = bad.map((re) => (text.match(re) || [])[0]).filter(Boolean)
  if (r.status !== 200 || !text.trim()) throw new Error("the terminal text could not be read (" + r.status + "): do not film it blind")
  if (hit.length) throw new Error("leak in the terminal text of " + name + ": " + hit.join(" | "))
}
const shot = async (t, name) => t.page.screenshot({ path: S + "/work/x-" + name + ".png" }).catch(() => {})
const bare = (t) => t.page.evaluate(() => { for (const id of ["__cur"]) document.getElementById(id)?.remove() }).catch(() => {})
const B = {
  async c1() { // empty dashboard, then the New agent wizard: folder, persona, the agent and its models
    const t = await beat(browser, "c1")
    await t.go("/agents"); await t.cap("One place for every agent you run."); await sleep(1800)
    await t.click(t.page.locator("button:text-is('New agent') >> visible=true").last()); await sleep(1200); await shot(t, "c1-dialog")
    await t.page.mouse.move(578, 440, { steps: 25 }); await sleep(300); await t.page.mouse.click(578, 440); await sleep(1500)   // the card is not a button: by position
    await t.cap("Pick a folder.")
    const folder = t.page.locator("input[value*='first-agent'], input[type=text] >> visible=true").first(); await t.move(folder); await folder.fill("~/projects/skyline"); await sleep(700)   // the default shows the demo's scratch path
    await t.click(t.page.locator("button:text-is('Next') >> visible=true").first()); await sleep(1800)
    await t.cap("Start from a persona, or from blank.")
    await t.click(t.page.locator("button:text-is('Next') >> visible=true").first()); await sleep(2200)
    await t.cap("Choose the agent and its model.")
    await shot(t, "c1-agent"); const sel = t.page.locator("select >> visible=true").first(); await t.move(sel); await sel.focus(); await sleep(900)
    for (let i = 0; i < 4; i++) { await t.page.keyboard.press("ArrowDown"); await sleep(1100) }   // a native menu is not drawn in a recording: step through the models instead
    await t.cap("Every model the CLI offers, one list.")
    await sleep(1800)
    await t.click(t.page.locator("button:text-is('Launch') >> visible=true").first()); await sleep(3500)   // launch the agent from the wizard
    await t.cap("It starts in its own folder, and it is on your list.")
    await sleep(3500)
    return t.finish()
  },
  async launch() { // not recorded: the team (the film showed the launch in c1's lead-in before; here the rows just appear)
    const r = await launchTeam(); if (!r.ok) throw new Error("launch failed"); await sleep(5000); return "launched"
  },
  async world() { // not recorded: a workspace with history: earlier goals with tasks, the main goal's tasks, the code change, the Inbox documents and the board chatter
    let n = 0
    for (const g of history.goals) {
      board("goal", "add", g.title, "--outcome", g.title, "--state", g.state === "proposed" ? "proposed" : "active")
      const gid = goalId(g.title)
      for (const [tt, st] of g.tasks) addTask(gid, tt, st, n++)
      if (g.state === "blocked") board("goal", "update", String(gid), "--state", "blocked", "--blocked-on", "Waiting for a decision on how long a cached forecast stays fresh")
      if (g.state === "done") board("goal", "close", String(gid), "--reason", "Shipped and checked")
    }
    flushClaims()
    for (const [f, src] of Object.entries(story.repo.change)) fs.copyFileSync(path.resolve(SEED, "..", src), REPO + "/" + f)
    for (const d of inbox) { agent(d.agent, "coral-agent", "artifact", "upload", SEED + "/" + d.file, "--name", d.name, "--tag", "for review", "--question", d.question); await sleep(1500) }
    for (const c of story.chatter) { agent(c[0], "coral-board", "post", c[1]); await sleep(900) }
    const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: 1600, height: 900 } }); const page = await ctx.newPage()   // hide the welcome items
    await page.goto(BASE + "/inbox/needs", { waitUntil: "domcontentloaded" }); await sleep(3000)
    const hide = page.locator("text=Hide all welcome items >> visible=true").first(); if (await hide.count()) { await hide.click(); await sleep(1500) }
    await ctx.close()
    return "world"
  },
  async chats() { // not recorded: each agent is briefed in its own chat and answers with the scripted replies (MOCK_AGENT_REPLIES), a tool step included
    const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: 1600, height: 900 } }); const page = await ctx.newPage()
    for (const c of chats) {
      await page.goto(BASE + "/agents/" + sid(c.agent), { waitUntil: "domcontentloaded" }); await sleep(2500)
      const box = page.getByPlaceholder(new RegExp("Message " + c.agent)); await box.click(); await page.keyboard.type(c.prompt); await page.keyboard.press("Enter"); await sleep(3500)
    }
    await ctx.close(); return "chats " + chats.length
  },
  async prompts() { // not recorded: the themed permission prompts and a question, fired just before the Inbox is shown (an agent's next turn clears its own)
    for (const p of story.prompts || []) { if (p.kind === "permission") askPermission(p.agent, p.command, p.description); else askQuestion(p.agent, p.header, p.question, p.options); await sleep(1200) }
    return "prompts " + (story.prompts || []).length
  },
  async real() { // the one real-CLI shot (the Operator's call): a real Claude Code launched in the demo's empty HOME, shown on its Terminal view, nothing typed.
    // REAL_CLAUDE=<path of the claude CLI>. Its text is read from the server first (termCheck) and printed for a person to read: an account name or email would stop the shot.
    const cli = process.env.REAL_CLAUDE; if (!cli || !fs.existsSync(cli)) throw new Error("set REAL_CLAUDE to the claude CLI")
    const H = { Authorization: "Bearer " + key(), "Content-Type": "application/json" }
    const put = (p) => fetch(BASE + "/api/settings", { method: "PUT", headers: H, body: JSON.stringify({ cli_path_claude: p }) })
    await put(cli)
    try {
      const r = await fetch(BASE + "/api/sessions/launch-team", { method: "POST", headers: H, body: JSON.stringify({ board_name: "solo", working_dir: REPO, agents: [{ agent_type: "claude", name: "Claude", prompt: "Skyline sample." }] }) })
      const j = await r.json(); if (!j.ok) throw new Error("the real launch was refused: " + JSON.stringify(j).slice(0, 200))
      const id = j.agents[0].session_id; await sleep(9000)
      const cap = await (await fetch(BASE + "/api/sessions/live/claude-" + id + "/capture", { headers: H })).text()
      fs.writeFileSync(S + "/work/real-terminal.txt", cap); console.error("REAL TERMINAL TEXT:\n" + cap.slice(0, 1500))
      const bad = [/\/tmp\//, /\/Users\//, /@[\w-]+\.[a-z]{2,}/i, /Welcome back/i, /scratchpad/, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i].map((re) => (cap.match(re) || [])[0]).filter(Boolean)
      if (bad.length) throw new Error("the real terminal shows: " + bad.join(" | "))
      const t = await beat(browser, "real")
      await t.go("/agents/" + id); await t.cap("Or the real thing: any CLI agent runs in Coral as it does in your terminal.")
      await t.click(t.page.locator("button[aria-label='Terminal view']")); await sleep(7000)
      return await t.finish()
    } finally { await put(S + "/bin/mock-agent") }
  },
  async c2() { // terminal first (it is the CLI), then the chat view of the same agent
    await termCheck("Orchestrator")
    const t = await beat(browser, "c2")
    await t.go("/agents"); await t.cap("Every agent is a CLI you already use.")
    await t.click(t.page.locator("text=Orchestrator >> visible=true").first()); await sleep(2500)
    await t.click(t.page.locator("button[aria-label='Terminal view']")); await sleep(3500)
    await t.cap("This is its terminal.")
    await sleep(2500)
    await t.click(t.page.locator("button[aria-label='Chat view']")); await sleep(2500)
    await t.cap("Chat is the same agent, easier to read.")
    await sleep(3500)
    return t.finish()
  },
  async c3() { // another agent's chat, already full, with its files and tasks
    const t = await beat(browser, "c3")
    await t.go("/agents/" + sid(diffAgent)); await t.cap("Every agent keeps its own conversation.")
    await sleep(4500)
    await t.click(t.page.locator("button[aria-label='Files']")); await t.cap("And the files it changed."); await sleep(2200)
    await t.click(t.page.locator("text=Expand all >> visible=true").first()); await t.cap("Expand all to read every change as a diff."); await sleep(3000)
    await t.page.mouse.move(1350, 500, { steps: 15 }); await t.page.mouse.wheel(0, 300); await sleep(3000)
    await t.click(t.page.locator("button[aria-label^='Tasks']")); await t.cap("And where its tasks stand."); await sleep(3500)
    return t.finish()
  },
  async c4() { // create the goal: a name, a description, a done-when and a picture
    const t = await beat(browser, "c4")
    await t.go("/inbox/goals"); await t.cap("Give the team a goal, in plain words.")
    await t.click(t.page.locator("button:has-text('New goal') >> visible=true").first()); await sleep(1200)
    const title = t.page.getByPlaceholder("Name the goal"); await t.click(title); await t.page.keyboard.type(story.goal.title, { delay: 40 }); await sleep(500)
    const body = t.page.locator("[contenteditable=true]:visible, textarea:visible").first(); await t.click(body)
    for (const [i, line] of story.goal.body.entries()) { if (i > 1) await t.page.keyboard.press("Enter"); await t.page.keyboard.type(i === 1 ? "- " + line : line, { delay: 12 }); if (i === 0) await t.page.keyboard.press("Enter") }   // the second line starts a list: "- " makes the bullet, the next lines continue it
    await sleep(600)
    const done = t.page.getByPlaceholder("What a person can check"); await t.click(done); await t.page.keyboard.type(story.goal.done, { delay: 25 }); await sleep(600)
    await t.cap("Add a picture, a mock-up or a screenshot.")
    // drop the picture on the box as a person would: the cursor goes to the box, then the page gets the drag events with the file; the file chooser is the fallback
    const zone = t.page.locator("text=Drop, paste or choose >> visible=true").first(); await t.move(zone); await sleep(500)
    const b64 = fs.readFileSync(SEED + "/" + story.goal.picture).toString("base64")
    await t.page.evaluate(([data, name]) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], name, { type: "image/png" }))
      let el = [...document.querySelectorAll("*")].filter((e) => /Drop, paste or choose/.test(e.textContent || "") && e.getBoundingClientRect().height < 220 && e.getBoundingClientRect().width > 0).pop()
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, [b64, story.goal.picture]); await sleep(2500)
    if (!(await t.page.locator("text=Drop, paste or choose").count().then((n) => n === 0).catch(() => false))) { await t.page.locator("input[type=file]").first().setInputFiles(SEED + "/" + story.goal.picture); await sleep(2500) }   // still empty: use the file chooser
    await t.cap("The guide sizes it as you write.")
    await sleep(2200)
    await t.click(t.page.locator("button:has-text('Create goal') >> visible=true").first()); await sleep(2500)
    return t.finish()
  },
  async c5() { // a goal about two thirds done: where is it? then a comment on the goal and the answer
    const gid = goalId(story.goal.title)
    goalTasks.forEach(([tt, st], i) => { if (!taskId(tt)) addTask(gid, tt, st, i) }); flushClaims()
    for (const [i, f] of ["forecast-api.md", "accuracy.csv", "test-plan.md"].entries()) {   // copies with a marker line: the same bytes as an Inbox document would be refused
      fs.writeFileSync(S + "/work/att-" + f, fs.readFileSync(SEED + "/" + f, "utf8") + "\n(attached to the goal)\n")
      try { const tk = taskOf(story.goalFilesTask); agent(tk.assigned_to, "coral-agent", "artifact", "upload", S + "/work/att-" + f, "--name", "goal-" + f, "--task", String(tk.id)) } catch (e) { console.error("attach failed: " + f) }
    }
    const t = await beat(browser, "c5")
    await t.go("/inbox/goals"); await t.cap("Every goal shows how far along it is.")
    await sleep(2500)
    await t.click(t.page.locator(`text=${story.goal.title} >> visible=true`).first()); await sleep(3500)
    await t.cap("Tasks by state, and the files they produced.")
    await t.page.mouse.move(900, 600, { steps: 20 }); await t.page.mouse.wheel(0, 400); await sleep(3000)
    await t.page.mouse.wheel(0, -400); await sleep(1200)
    await t.click(t.page.locator("text=Artifacts >> visible=true").last()); await t.cap("The files its tasks produced."); await sleep(2500)
    await t.cap("Ask about it right on the goal.")
    await t.cap("Ask about it right on the goal.")
    await t.click(t.page.locator("text=Comments >> visible=true").last()); await sleep(1500)
    await pclick(t, t.page.locator("button.ac-whole >> visible=true").first()); await sleep(900); await shot(t, "c5-opened")
    // keys sent to the goal panel's box do not land in it in a recording: grow its value letter by letter instead, with the page's own input events
    const typeGoal = async (text) => {
      const box = t.page.locator(".ac-composer .ac-input >> visible=true").first(); await t.move(box)
      for (const ch of text) { await box.evaluate((el, c) => { el.value += c; el.dispatchEvent(new Event("input", { bubbles: true })) }, ch); await sleep(22) }
    }
    await typeGoal(goalComment.text); await sleep(400)
    await pclick(t, t.page.locator(".ac-composer button >> visible=true").filter({ hasText: /^Comment$/ }).first()); await sleep(1500)
    const bid = JSON.parse(board("goal", "list", "--state", "all", "--json")).find((g) => g.id === gid).board_id
    const link = "coral://goals/" + bid + "/" + gid
    let cid; for (let k = 0; k < 14 && !cid; k++) { await sleep(500); try { cid = (agent("Orchestrator", "coral-agent", "artifact", "comments", link).match(/Thread (\d+)/) || [])[1] } catch (e) { /* not asked in yet */ } }
    if (!cid) throw new Error("the goal comment never reached the agent")
    board("task", "add", goalComment.newTask, "--goal", String(gid), "--assignee", "Frontend")   // the answer says a task was added: it is
    agent("Orchestrator", "coral-agent", "artifact", "reply", link, cid, goalComment.reply)
    await t.cap("The agent answers, and adds a task.")
    const seen = () => t.page.locator("text=" + goalComment.replyFind).first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)
    if (!(await seen())) { await t.click(t.page.locator("text=Tasks >> visible=true").last()); await sleep(1200); await t.click(t.page.locator("text=Comments >> visible=true").last()); await seen() }   // the panel did not take the answer live: draw it again
    await sleep(4500)
    return t.finish()
  },
  async c6() { // the Inbox: an agent's question, Open agent, answer it
    const t = await beat(browser, "c6")
    await t.go("/inbox/needs"); await t.cap("Your Inbox: everything that is waiting on you.")
    await sleep(3000)
    await t.move(t.page.locator("text=Celsius or Fahrenheit >> visible=true").first()); await sleep(800)
    await t.click(t.page.locator("text=Celsius or Fahrenheit >> visible=true").first().locator("xpath=ancestor::*[.//button[normalize-space()='Open agent']][1]//button[normalize-space()='Open agent']")); await sleep(3500)
    await t.cap("Open the agent that asked.")
    await sleep(2500)
    return t.finish()
  },
  async c7() { // a document to review: comment on it, the new version comes back at once, and Compare
    fs.writeFileSync(S + "/work/live.md", fs.readFileSync(SEED + "/" + live.file, "utf8") + "\n<!-- take " + Date.now() + " -->\n")   // a hidden marker: the same bytes as an earlier take would be refused
    const t = await beat(browser, "c7")
    await t.go("/inbox/needs")
    const up = uploadOf(agent(live.agent, "coral-agent", "artifact", "upload", S + "/work/live.md", "--name", live.name, "--tag", "for review", "--question", live.question))
    const row = t.page.locator(`text=${live.name} >> visible=true`).first()
    const there = await row.waitFor({ state: "visible", timeout: 12000 }).then(() => true).catch(() => false)
    if (!there) { await shot(t, "c7-list"); await t.page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500) }   // the list did not take the new item live: load it again
    await t.click(row); await sleep(2500)
    await t.cap("A file to review, with everything it says.")
    await t.page.mouse.wheel(0, 500); await sleep(2500); await t.page.mouse.wheel(0, -500); await sleep(1000)
    await t.click(t.page.getByRole("button", { name: /^Comments/ })); await sleep(900)
    await pclick(t, t.page.locator("button.ac-whole >> visible=true").first()); await sleep(700)
    const box = t.page.locator(".ac-composer .ac-input >> visible=true").first()
    await t.cap("Comment on it.")
    await typeInto(t, box, live.comment, 18); await sleep(400)
    await pclick(t, t.page.locator(".ac-composer button >> visible=true").filter({ hasText: /^Comment$/ }).first())
    await sleep(1500); await shot(t, "c7-after-send")
    const link = up.series_id ? "coral://artifacts/series/" + up.series_id : up.uri   // an earlier take of the same name makes this a version: comments belong to the series
    let id; for (let k = 0; k < 14 && !id; k++) { await sleep(500); try { const o = agent(live.agent, "coral-agent", "artifact", "comments", link); id = (o.match(/Thread (\d+)/) || [])[1]; if (!id && k === 13) console.error("comments output: " + o.slice(0, 300)) } catch (e) { if (k === 13) console.error("comments error: " + String(e.stderr || e.message).slice(0, 300)) } }   // the comment reaches the agent a moment after Send
    if (!id) throw new Error("the comment never reached the agent")
    let txt = fs.readFileSync(S + "/work/live.md", "utf8"); for (const [a, b] of live.edits) txt = txt.replace(a, b); fs.writeFileSync(S + "/work/live.md", txt)
    agent(live.agent, "coral-agent", "artifact", "reply", link, id, live.reply)
    agent(live.agent, "coral-agent", "artifact", "upload", S + "/work/live.md", "--name", live.name, "--new-version-of", link, "--tag", "for review", "--question", live.question2)
    await t.cap("The answer and a new version, within seconds.")
    await t.page.locator(`text=${live.replyFind}`).first().waitFor({ state: "visible", timeout: 9000 }).catch(() => shot(t, "c7-noreply"))
    await sleep(3000)
    return t.finish()
  },
  async c8() { // the agent's changes: the expanded diff
    const t = await beat(browser, "c8")
    await t.go("/agents/" + sid(diffAgent)); await sleep(2500)
    await t.click(t.page.locator("button[aria-label='Files']")); await sleep(2000)
    await t.cap("Every change, with its diff.")
    await t.click(t.page.locator(`text=${changed[1]} >> visible=true`).first()); await sleep(2500)
    await t.click(t.page.locator("button[aria-label='Dock preview as a full-height column']")); await sleep(3000)
    await t.cap("Expand it to read the whole change.")
    await t.page.mouse.move(900, 500, { steps: 15 }); await t.page.mouse.wheel(0, 300); await sleep(3500)
    return t.finish()
  },
  async c9() { // Analytics: totals, the spend chart, cost by provider, model and team
    const t = await beat(browser, "c9")
    await t.page.addInitScript(() => setInterval(() => document.querySelectorAll("[class*=toast]").forEach((e) => e.remove()), 150))   // a restart notice from re-opening the rig is not part of the story
    await t.go("/analytics"); await t.cap("What did the team cost?")
    await sleep(2500)
    const range = t.page.locator("select:has(option)").filter({ has: t.page.locator("option", { hasText: /7 days|week/i }) }).first()   // the time range: a week, so the invented history shows
    if (await range.count()) { const label = await range.evaluate((el) => [...el.options].find((o) => /7 days|week/i.test(o.text))?.text); await t.move(range); await range.selectOption({ label }); await sleep(3500) } else await shot(t, "c9-norange")
    await t.cap("A week of spend, by day.")
    await sleep(2500)
    await t.page.mouse.move(900, 500, { steps: 15 }); await t.page.mouse.wheel(0, 450); await t.cap("By provider, model and team."); await sleep(3500)
    await t.page.mouse.wheel(0, 450); await sleep(3500)
    return t.finish()
  },
  async c10() { // back to the Inbox for the end
    const t = await beat(browser, "c10")
    await t.go("/inbox/needs"); await t.cap(""); await sleep(3500)
    return t.finish()
  },
}
for (const n of which) {
  try { out[n] = await B[n]() } catch (e) { console.error("FAILED " + n + ": " + String(e.message).split("\n").slice(0, 3).join(" / ")); for (const c of OPEN) await c.close().catch(() => {}); process.exitCode = 1; break }
}
console.log(JSON.stringify(out))
await browser.close()
