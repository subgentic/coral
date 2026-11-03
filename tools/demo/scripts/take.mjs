import fs from "node:fs"
import path from "node:path"
import { OPEN, chromium, beat, launchTeam, sleep, agent, askPermission, askQuestion, BASE, S, SEED, PORT, REPO, story } from "./lib.mjs"
process.env.CORAL_TELEMETRY_DISABLED = "1" // the demo Coral and everything the takes start send no usage events
const which = process.argv.slice(2)
const browser = await chromium.launch({ headless: true })
const out = {}
const { live, inbox, diffAgent } = story
const uploadOf = (r) => JSON.parse(r.split("\n").find((l) => l.startsWith("{")))
const changed = Object.keys(story.repo.change)   // e.g. forecast.go and forecast_test.go
const B = {
  async b1() { // empty dashboard
    const t = await beat(browser, "b1")
    await t.go("/agents"); await t.cap("One place for every agent you run."); await sleep(1500)
    await t.move(t.page.locator("text=New team >> visible=true").first(), 40); await sleep(3000)
    return t.finish()
  },
  async b2() { // launch a team: rows appear live
    const t = await beat(browser, "b2")
    await t.go("/agents"); await t.cap("Launch a whole team in one step.")
    await t.page.locator("text=New team >> visible=true").first().hover(); await sleep(1200)
    const r = await launchTeam(); if (!r.ok) throw new Error("launch failed")
    await sleep(3500)
    await t.cap("Each agent keeps its own terminal.")
    await t.click(t.page.locator(`text=${diffAgent} >> visible=true`).first()); await sleep(4500)
    return t.finish()
  },
  async seed() { // not recorded: a busy Inbox. Documents from several agents (the oldest first), a conversation on the board, the welcome items hidden
    let n = 0
    for (const d of inbox) {
      agent(d.agent, "coral-agent", "artifact", "upload", SEED + "/" + d.file, "--name", d.name, "--tag", "for review", "--question", d.question)
      const c = story.chatter[n++]; if (c) agent(c[0], "coral-board", "post", c[1])
      await sleep(9000)   // so the items are a few seconds to minutes apart when the Inbox is shown
    }
    for (const c of story.chatter.slice(n)) { agent(c[0], "coral-board", "post", c[1]); await sleep(1500) }
    const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: 1600, height: 900 } }); const page = await ctx.newPage()
    await page.goto(BASE + "/inbox/needs", { waitUntil: "domcontentloaded" }); await sleep(3000)
    const hide = page.locator("text=Hide all welcome items >> visible=true").first(); if (await hide.count()) { await hide.click(); await sleep(1500) }
    await ctx.close(); return "seeded " + inbox.length
  },
  async prompts() { // not recorded: themed permission prompts and a question from other agents (fired just before the Inbox is shown: an agent's next turn clears its own)
    for (const p of story.prompts || []) { if (p.kind === "permission") askPermission(p.agent, p.command, p.description); else askQuestion(p.agent, p.header, p.question, p.options); await sleep(1200) }
    return "prompts " + (story.prompts || []).length
  },
  async b3() { // create a goal for the team
    const t = await beat(browser, "b3")
    await t.go("/inbox/goals"); await t.cap("Give the team a goal, in plain words.")
    await t.click(t.page.locator("button:has-text('New goal') >> visible=true").first()); await sleep(1200)
    const title = t.page.getByPlaceholder("Name the goal"); await t.click(title); await t.page.keyboard.type(story.goal.title, { delay: 45 }); await sleep(500)
    const done = t.page.getByPlaceholder("What a person can check"); await t.click(done); await t.page.keyboard.type(story.goal.done, { delay: 35 }); await sleep(700)
    await t.click(t.page.locator("button:has-text('Create goal') >> visible=true").first()); await sleep(2500)
    await t.cap("It turns into tasks for the agents.")
    const gid = JSON.parse(agent("Orchestrator", "coral-board", "goal", "list", "--json"))[0].id
    for (const ti of story.tasks) { agent("Orchestrator", "coral-board", "task", "add", ti, "--goal", String(gid)); await sleep(900) }
    await sleep(2500); await t.page.reload({ waitUntil: "domcontentloaded" }); await sleep(3500)
    return t.finish()
  },
  async b4() { // a document lands in the Inbox; comment; the agent answers
    fs.copyFileSync(SEED + "/" + live.file, S + "/work/live.md")
    const t = await beat(browser, "b4")
    await t.go("/inbox/needs"); await t.cap("Work lands in your Inbox."); await sleep(3500)
    const up = uploadOf(agent(live.agent, "coral-agent", "artifact", "upload", S + "/work/live.md", "--name", live.name, "--tag", "for review", "--question", live.question))
    await sleep(3500)
    const row = t.page.locator(`text=${live.name} >> visible=true`).first()
    if (!(await row.isVisible().catch(() => false))) { await t.page.screenshot({ path: S + "/work/x-b4-notlive.png" }); await t.page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500) }
    await t.click(row); await sleep(1800)
    await t.cap("Comment on it. The agent answers.")
    await t.click(t.page.getByRole("button", { name: "Comments" })); await sleep(900)
    await t.click(t.page.getByRole("button", { name: "Comment on the whole document" })); await sleep(900)
    const box = t.page.locator("textarea:visible, [contenteditable=true]:visible").last(); await t.click(box)
    await t.page.keyboard.type(live.comment, { delay: 40 }); await sleep(600)
    const send = t.page.getByRole("button", { name: /^(Comment|Post|Send|Add comment|Save)$/ }).last()
    if (await send.count()) await t.click(send); else await t.page.keyboard.press("Control+Enter")
    await sleep(2000)
    const cs = agent(live.agent, "coral-agent", "artifact", "comments", up.uri)
    const id = (cs.match(/Thread (\d+)/) || [])[1]
    agent(live.agent, "coral-agent", "artifact", "reply", up.uri, id, live.reply)
    await sleep(2000)
    fs.writeFileSync(S + "/work/live.md", fs.readFileSync(S + "/work/live.md", "utf8").replace(live.from, live.to))
    agent(live.agent, "coral-agent", "artifact", "upload", S + "/work/live.md", "--name", live.name, "--new-version-of", up.uri, "--tag", "for review", "--question", live.question2)
    const seen = await t.page.locator(`text=${live.replyFind}`).first().waitFor({ state: "visible", timeout: 7000 }).then(() => true).catch(() => false)
    if (!seen) { // the open dialog does not live-update: close it and open the item again
      await t.click(t.page.getByRole("button", { name: "Close" }).last()); await sleep(1200)
      await t.page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500)
      await t.click(t.page.locator(`text=${live.name} >> visible=true`).first()); await sleep(1500)
      await t.click(t.page.getByRole("button", { name: /^Comments/ })); await sleep(1500)
    }
    await t.cap("The agent answered and updated the note.")
    await sleep(4500)
    return t.finish()
  },
  async b5() { // open an agent: its changes, the diff and the tasks
    for (const [f, src] of Object.entries(story.repo.change)) fs.copyFileSync(path.resolve(SEED, "..", src), REPO + "/" + f)
    const t = await beat(browser, "b5")
    await t.go("/agents"); await t.cap("Open an agent to see what it changes.")
    await t.click(t.page.locator(`text=${diffAgent} >> visible=true`).first()); await sleep(3500)
    await t.cap("Every change, with its diff and tasks.")
    await t.click(t.page.locator(`text=${changed[1]} >> visible=true`).first()); await sleep(2500)
    await t.click(t.page.locator(`text=${changed[0]} >> visible=true`).first()); await sleep(3500)
    await t.page.mouse.move(1200, 780, { steps: 20 }); await t.page.mouse.wheel(0, 300); await sleep(2000)
    await t.click(t.page.locator("button[aria-label*='ask' i], button[title*='ask' i]").first().or(t.page.locator("text=Tasks >> visible=true").first())).catch(() => {}); await sleep(2500)
    return t.finish()
  },
  async perm() { // not recorded: ask one agent's mock for a permission prompt
    const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: 1600, height: 900 } }); const page = await ctx.newPage()
    const id = JSON.parse(fs.readFileSync(S + "/work/launch.json", "utf8")).agents.find((a) => a.name === story.permAgent).session_id
    await page.goto(BASE + "/agents/" + id, { waitUntil: "domcontentloaded" }); await sleep(3000)
    const box = page.getByPlaceholder(new RegExp("Message " + story.permAgent)); await box.click(); await page.keyboard.type("MOCK_ASK_PERMISSION"); await page.keyboard.press("Enter"); await sleep(4000)
    await ctx.close(); return "ok"
  },
  async drain() { // not recorded: answer every stale permission prompt, so the film shows exactly one
    const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true }); const page = await ctx.newPage()
    await page.goto(BASE + "/inbox/needs", { waitUntil: "domcontentloaded" }); await sleep(3000)
    let n = 0
    for (; n < 8; n++) { const y = page.locator("button:text-is('Yes') >> visible=true").first(); if (!(await y.count())) break; await y.click(); await sleep(3500) }
    await ctx.close(); return "drained " + n
  },
  async b6() { // the phone: a quick tour, then approve
    const t = await beat(browser, "b6", { w: 430, h: 932, mobile: true })
    await t.go("/inbox/needs"); await t.cap("The same team, on your phone."); await sleep(2000)
    for (const [label, wait] of [["Agents", 2200], ["Inbox", 1500]]) { await t.click(t.page.locator("text=" + label + " >> visible=true").last()); await sleep(wait) }
    await t.cap("Approve a prompt without leaving the couch.")
    await sleep(1200)
    // the Yes of the mock's own prompt (the one that can really be answered), not of the themed prompts the seed step fired
    await t.click(t.page.getByText("rm -rf build").first().locator("xpath=ancestor::*[.//button[normalize-space()='Yes']][1]//button[normalize-space()='Yes']")); await sleep(3000)
    await t.cap("See what it all cost.")
    await t.click(t.page.locator("text=Analytics >> visible=true").last()); await sleep(3000)
    for (let i = 0; i < 1; i++) { await t.page.mouse.wheel(0, 300); await sleep(1500) }   // the cost cards only: the cost-by-team chart below them names a team by its board id (a product bug, #13044) until that is fixed
    return t.finish()
  },
  async b7() { // zoom back out to the desktop Inbox
    const t = await beat(browser, "b7")
    await t.go("/inbox/needs"); await t.cap(""); await sleep(3500)
    return t.finish()
  },
}
for (const n of which) {
  try { out[n] = await B[n]() } catch (e) { console.error("FAILED " + n + ": " + String(e.message).split("\n")[0]); for (const c of OPEN) await c.close().catch(() => {}); process.exitCode = 1; break }
}
console.log(JSON.stringify(out))
await browser.close()
