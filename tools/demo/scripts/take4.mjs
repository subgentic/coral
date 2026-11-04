import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { OPEN, chromium, beat, launchTeam, sleep, agent, BASE, S, SEED, REPO, HERE, story } from "./lib.mjs"
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
const taskId = (title) => JSON.parse(board("task", "list", "--json")).find((x) => x.title === title)?.id
const WORKERS = ["Backend", "Frontend", "Designer", "Reviewer"]
// add one task to a goal and bring it to a state: completed (done by a worker), in_progress (claimed), pending (left open)
function addTask(gid, title, state, n) {
  const who = WORKERS[n % WORKERS.length]
  board("task", "add", title, "--goal", String(gid), "--assignee", who)
  const id = taskId(title)
  if (state === "completed" || state === "in_progress") agent(who, "coral-board", "task", "claim", String(id))
  if (state === "completed") agent(who, "coral-board", "task", "complete", String(id), "--message", "Done.")
  return id
}
const shot = async (t, name) => t.page.screenshot({ path: S + "/work/x-" + name + ".png" }).catch(() => {})
const bare = (t) => t.page.evaluate(() => { for (const id of ["__cur"]) document.getElementById(id)?.remove() }).catch(() => {})
const B = {
  async c1() { // empty dashboard, then the New agent wizard: folder, persona, the agent and its models
    const t = await beat(browser, "c1")
    await t.go("/agents"); await t.cap("One place for every agent you run."); await sleep(1800)
    await t.click(t.page.locator("button:has-text('New agent') >> visible=true").last()); await sleep(1200)
    await t.click(t.page.locator("button:has-text('One agent in a') >> visible=true").first()); await sleep(1500)
    await t.cap("Pick a folder.")
    await t.click(t.page.locator("button:text-is('Next') >> visible=true").first()); await sleep(1800)
    await t.cap("Start from a persona, or from blank.")
    await t.click(t.page.locator("button:text-is('Next') >> visible=true").first()); await sleep(2200)
    await t.cap("Choose the agent and its model.")
    await t.click(t.page.locator("select >> visible=true").first()); await sleep(1500)
    await t.page.keyboard.press("Escape"); await sleep(800)
    await t.click(t.page.locator("button:has-text('Refresh models') >> visible=true").first()); await sleep(2500)
    await t.cap("Every model the CLI offers, one list.")
    await sleep(2500)
    await t.click(t.page.locator("button:text-is('Cancel') >> visible=true").first()); await sleep(1000)
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
    for (const [f, src] of Object.entries(story.repo.change)) fs.copyFileSync(path.resolve(SEED, "..", src), REPO + "/" + f)
    for (const d of inbox) { agent(d.agent, "coral-agent", "artifact", "upload", SEED + "/" + d.file, "--name", d.name, "--tag", "for review", "--question", d.question); await sleep(1500) }
    for (const c of story.chatter) { agent(c[0], "coral-board", "post", c[1]); await sleep(900) }
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
  async c2() { // terminal first (it is the CLI), then the chat view of the same agent
    const t = await beat(browser, "c2")
    await t.go("/agents"); await t.cap("Every agent is a CLI you already use.")
    await t.click(t.page.locator("text=Orchestrator >> visible=true").first()); await sleep(2500)
    await t.click(t.page.locator("button[title*='erminal' i], button[aria-label*='erminal' i]").first()); await sleep(3500)
    await t.cap("This is its terminal.")
    await sleep(2500)
    await t.click(t.page.locator("button[title*='hat' i], button[aria-label*='hat' i]").first()); await sleep(2500)
    await t.cap("Chat is the same agent, easier to read.")
    await sleep(3500)
    return t.finish()
  },
  async c3() { // another agent's chat, already full, with its files and tasks
    const t = await beat(browser, "c3")
    await t.go("/agents/" + sid(diffAgent)); await t.cap("Every agent keeps its own conversation.")
    await sleep(4500)
    await t.click(t.page.locator("text=Files >> visible=true").first()); await t.cap("And the files it changed."); await sleep(3500)
    return t.finish()
  },
  async c4() { // create the goal: a name, a description, a done-when and a picture
    const t = await beat(browser, "c4")
    await t.go("/inbox/goals"); await t.cap("Give the team a goal, in plain words.")
    await t.click(t.page.locator("button:has-text('New goal') >> visible=true").first()); await sleep(1200)
    const title = t.page.getByPlaceholder("Name the goal"); await t.click(title); await t.page.keyboard.type(story.goal.title, { delay: 40 }); await sleep(500)
    const body = t.page.locator("[contenteditable=true]:visible, textarea:visible").first(); await t.click(body)
    for (const line of story.goal.body) { await t.page.keyboard.type(line, { delay: 12 }); await t.page.keyboard.press("Enter") }
    await sleep(600)
    const done = t.page.getByPlaceholder("What a person can check"); await t.click(done); await t.page.keyboard.type(story.goal.done, { delay: 25 }); await sleep(600)
    await t.cap("Add a picture, a mock-up or a screenshot.")
    await t.page.locator("input[type=file]").first().setInputFiles(SEED + "/" + story.goal.picture); await sleep(2500)
    await t.cap("The guide sizes it as you write.")
    await sleep(2200)
    await t.click(t.page.locator("button:has-text('Create goal') >> visible=true").first()); await sleep(2500)
    return t.finish()
  },
  async c5() { // a goal about two thirds done: where is it? then a comment on the goal and the answer
    const gid = goalId(story.goal.title)
    goalTasks.forEach(([tt, st], i) => addTask(gid, tt, st, i))
    for (const f of ["forecast-api.md", "accuracy.csv", "test-plan.md"]) agent("Backend", "coral-agent", "artifact", "upload", SEED + "/" + f, "--name", "skyline-" + f, "--task", String(taskId(goalTasks[0][0]))).toString()
    const t = await beat(browser, "c5")
    await t.go("/inbox/goals"); await t.cap("Every goal shows how far along it is.")
    await sleep(2500)
    await t.click(t.page.locator(`text=${story.goal.title} >> visible=true`).first()); await sleep(3500)
    await t.cap("Tasks by state, and the files they produced.")
    await t.page.mouse.move(900, 600, { steps: 20 }); await t.page.mouse.wheel(0, 400); await sleep(3000)
    await t.page.mouse.wheel(0, -400); await sleep(1200)
    await t.cap("Ask about it right on the goal.")
    await t.click(t.page.getByRole("button", { name: /Comments/ }).first()); await sleep(1200)
    await t.click(t.page.getByRole("button", { name: /Comment on the whole/i }).first()).catch(() => {}); await sleep(900)
    const box = t.page.locator("textarea:visible, [contenteditable=true]:visible").last(); await t.click(box)
    await t.page.keyboard.type(goalComment.text, { delay: 35 }); await sleep(500)
    const send = t.page.getByRole("button", { name: /^(Comment|Post|Send|Add comment|Save)$/ }).last()
    if (await send.count()) await t.click(send); else await t.page.keyboard.press("Control+Enter")
    await sleep(1500)
    const link = "coral://goals/" + story.team + "/" + gid
    const cs = agent("Orchestrator", "coral-agent", "artifact", "comments", link); const cid = (cs.match(/Thread (\d+)/) || [])[1]
    agent("Orchestrator", "coral-agent", "artifact", "reply", link, cid, goalComment.reply); await sleep(1500)
    await t.cap("The agent answers in a few seconds.")
    await sleep(4000)
    return t.finish()
  },
  async c6() { // the Inbox: an agent's question, Open agent, answer it
    const t = await beat(browser, "c6")
    await t.go("/inbox/needs"); await t.cap("Your Inbox: everything that is waiting on you.")
    await sleep(3000)
    await t.click(t.page.locator("text=Celsius or Fahrenheit >> visible=true").first()); await sleep(1500)
    await t.click(t.page.locator("button:has-text('Open agent') >> visible=true").first()); await sleep(3500)
    await t.cap("Open the agent that asked.")
    await sleep(2500)
    return t.finish()
  },
  async c7() { // a document to review: comment on it, the new version comes back at once, and Compare
    fs.copyFileSync(SEED + "/" + live.file, S + "/work/live.md")
    const t = await beat(browser, "c7")
    await t.go("/inbox/needs")
    const up = uploadOf(agent(live.agent, "coral-agent", "artifact", "upload", S + "/work/live.md", "--name", live.name, "--tag", "for review", "--question", live.question))
    await sleep(3500)
    await t.click(t.page.locator(`text=${live.name} >> visible=true`).first()); await sleep(2500)
    await t.cap("A file to review, with everything it says.")
    await t.page.mouse.wheel(0, 500); await sleep(2500); await t.page.mouse.wheel(0, -500); await sleep(1000)
    await t.click(t.page.getByRole("button", { name: /^Comments/ })); await sleep(900)
    await t.click(t.page.getByRole("button", { name: /Comment on the whole/i })); await sleep(700)
    const box = t.page.locator("textarea:visible, [contenteditable=true]:visible").last(); await t.click(box)
    await t.cap("Comment on it.")
    await t.page.keyboard.type(live.comment, { delay: 30 }); await sleep(400)
    const send = t.page.getByRole("button", { name: /^(Comment|Post|Send|Add comment|Save)$/ }).last()
    if (await send.count()) await t.click(send); else await t.page.keyboard.press("Control+Enter")
    await sleep(900)
    const cs = agent(live.agent, "coral-agent", "artifact", "comments", up.uri); const id = (cs.match(/Thread (\d+)/) || [])[1]
    let txt = fs.readFileSync(S + "/work/live.md", "utf8"); for (const [a, b] of live.edits) txt = txt.replace(a, b); fs.writeFileSync(S + "/work/live.md", txt)
    agent(live.agent, "coral-agent", "artifact", "reply", up.uri, id, live.reply)
    agent(live.agent, "coral-agent", "artifact", "upload", S + "/work/live.md", "--name", live.name, "--new-version-of", up.uri, "--tag", "for review", "--question", live.question2)
    await t.cap("The answer and a new version, within seconds.")
    await t.page.locator(`text=${live.replyFind}`).first().waitFor({ state: "visible", timeout: 9000 }).catch(() => shot(t, "c7-noreply"))
    await sleep(3000)
    return t.finish()
  },
  async c8() { // the agent's changes: the expanded diff
    const t = await beat(browser, "c8")
    await t.go("/agents/" + sid(diffAgent)); await sleep(2500)
    await t.click(t.page.locator("text=Files >> visible=true").first()); await sleep(2000)
    await t.cap("Every change, with its diff.")
    await t.click(t.page.locator(`text=${changed[1]} >> visible=true`).first()); await sleep(2500)
    await t.click(t.page.locator("button[title*='xpand' i], button[aria-label*='xpand' i]").first()); await sleep(3000)
    await t.cap("Expand it to read the whole change.")
    await t.page.mouse.move(900, 500, { steps: 15 }); await t.page.mouse.wheel(0, 300); await sleep(3500)
    return t.finish()
  },
  async c9() { // Analytics: totals, the spend chart, cost by provider, model and team
    const t = await beat(browser, "c9")
    await t.go("/analytics"); await t.cap("What did the team cost?")
    await sleep(4000)
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
  try { out[n] = await B[n]() } catch (e) { console.error("FAILED " + n + ": " + String(e.message).split("\n")[0]); for (const c of OPEN) await c.close().catch(() => {}); process.exitCode = 1; break }
}
console.log(JSON.stringify(out))
await browser.close()
