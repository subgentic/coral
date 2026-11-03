import fs from "node:fs"
import { OPEN, chromium, beat, launchTeam, sleep, agent, BASE, KEY, S, SEED, HERE, PORT } from "./lib.mjs"
const which = process.argv.slice(2)
const browser = await chromium.launch({ headless: true })
const out = {}
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
    await t.click(t.page.locator("text=Developer >> visible=true").first()); await sleep(4500)
    return t.finish()
  },
  async b3() { // create a goal for the team
    const t = await beat(browser, "b3")
    await t.go("/inbox/goals"); await t.cap("Give the team a goal, in plain words.")
    await t.click(t.page.locator("button:has-text('New goal') >> visible=true").first()); await sleep(1200)
    const title = t.page.getByPlaceholder("Name the goal"); await t.click(title); await t.page.keyboard.type("Slug handles punctuation and accents", { delay: 45 }); await sleep(500)
    const done = t.page.getByPlaceholder("What a person can check"); await t.click(done); await t.page.keyboard.type("Slug tests pass for punctuation, accents and empty input", { delay: 35 }); await sleep(700)
    await t.click(t.page.locator("button:has-text('Create goal') >> visible=true").first()); await sleep(2500)
    await t.cap("It turns into tasks for the agents.")
    const gid = JSON.parse(agent("Orchestrator", "coral-board", "goal", "list", "--json"))[0].id
    for (const [ti, who] of [["Handle punctuation in Slug", "Developer"], ["Add accent and empty-input tests", "Developer"], ["Review the Slug changes", "Reviewer"]]) {
      agent("Orchestrator", "coral-board", "task", "add", ti, "--goal", String(gid)); await sleep(900)
    }
    await sleep(2500); await t.page.reload({ waitUntil: "domcontentloaded" }); await sleep(3500)
    return t.finish()
  },
  async b4() { // a document lands in the Inbox; comment; the agent answers
    fs.copyFileSync(SEED + "/api-note.md", S + "/work/api-note.md")
    agent("Reviewer", "coral-agent", "artifact", "upload", SEED + "/test-plan.md", "--name", "slug-test-plan.md", "--tag", "for review", "--question", "Is this test plan enough for Slug?")
    const t = await beat(browser, "b4")
    await t.go("/inbox/needs"); await t.cap("Work lands in your Inbox."); await sleep(3000)
    const up = JSON.parse(agent("Developer", "coral-agent", "artifact", "upload", S + "/work/api-note.md", "--name", "slug-api-note.md", "--tag", "for review", "--question", "Keep accents in Slug, or make them plain letters?").split("\n").find((l) => l.startsWith("{")))
    await sleep(3500)
    const row = t.page.locator("text=slug-api-note.md >> visible=true").first()
    if (!(await row.isVisible().catch(() => false))) { await t.page.screenshot({ path: S + "/work/x-b4-notlive.png" }); await t.page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500) }
    await t.click(row); await sleep(1800)
    await t.cap("Comment on it. The agent answers.")
    await t.click(t.page.getByRole("button", { name: "Comments" })); await sleep(900)
    await t.click(t.page.getByRole("button", { name: "Comment on the whole document" })); await sleep(900)
    const box = t.page.locator("textarea:visible, [contenteditable=true]:visible").last(); await t.click(box)
    await t.page.keyboard.type("Keep accents: users search with them.", { delay: 40 }); await sleep(600)
    await t.page.screenshot({ path: S + "/work/x-b4-typed.png" })
    const send = t.page.getByRole("button", { name: /^(Comment|Post|Send|Add comment|Save)$/ }).last()
    if (await send.count()) await t.click(send); else await t.page.keyboard.press("Control+Enter")
    await sleep(2000)
    const cs = agent("Developer", "coral-agent", "artifact", "comments", up.uri)
    const id = (cs.match(/Thread (\d+)/) || [])[1]
    agent("Developer", "coral-agent", "artifact", "reply", up.uri, id, "Agreed: accents stay. I updated the note and the tests.")
    await sleep(2000)
    fs.writeFileSync(S + "/work/api-note.md", fs.readFileSync(S + "/work/api-note.md", "utf8").replace("Should accented letters be kept, or turned into plain letters?", "Decision: accented letters are kept (the reviewer asked for it)."))
    agent("Developer", "coral-agent", "artifact", "upload", S + "/work/api-note.md", "--new-version-of", up.uri, "--tag", "for review", "--question", "Approve the updated Slug API note?")
    const seen = await t.page.locator("text=accents stay").first().waitFor({ state: "visible", timeout: 7000 }).then(() => true).catch(() => false)
    if (!seen) { // the open dialog does not live-update: close it and open the item again
      await t.page.screenshot({ path: S + "/work/x-b4-fb1.png" }); await t.click(t.page.getByRole("button", { name: "Close" }).last()); await sleep(1200)
      await t.page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500)
      await t.page.screenshot({ path: S + "/work/x-b4-fb2.png" }); await t.click(t.page.locator("text=slug-api-note.md >> visible=true").first()); await sleep(1500)
      await t.page.screenshot({ path: S + "/work/x-b4-fb3.png" }); await t.click(t.page.getByRole("button", { name: /^Comments/ })); await sleep(1500)
    }
    await t.cap("The agent answered and updated the note.")
    await sleep(4500)
    await t.page.screenshot({ path: S + "/work/x-b4-end.png" })
    return t.finish()
  },
  async b5() { // follow the agent into its diff and tasks
    fs.copyFileSync(SEED + "/slug.go.new", S + "/repo/slug.go"); fs.copyFileSync(SEED + "/slug_test.go.new", S + "/repo/slug_test.go")
    const t = await beat(browser, "b5")
    await t.go("/agents"); await t.cap("Click the agent to see what it changes.")
    await t.click(t.page.locator("text=Developer >> visible=true").first()); await sleep(3500)
    await t.cap("Every change, with its diff and tasks.")
    await t.click(t.page.locator("text=slug_test.go >> visible=true").first()); await sleep(2500)
    await t.click(t.page.locator("text=slug.go >> visible=true").first()); await sleep(3500)
    await t.page.mouse.move(1200, 780, { steps: 20 }); await t.page.mouse.wheel(0, 300); await sleep(2000)
    await t.click(t.page.locator("button[aria-label*='ask' i], button[title*='ask' i]").first().or(t.page.locator("text=Tasks >> visible=true").first())).catch(() => {}); await sleep(2500)
    return t.finish()
  },
  async perm() { // not recorded: ask the Developer mock for a permission prompt
    const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: 1600, height: 900 } }); const page = await ctx.newPage()
    const id = JSON.parse(fs.readFileSync(S + "/work/launch.json", "utf8")).agents.find((a) => a.name === "Developer").session_id
    await page.goto(BASE + "/agents/" + id, { waitUntil: "domcontentloaded" }); await sleep(3000)
    const box = page.getByPlaceholder(/Message Developer/); await box.click(); await page.keyboard.type("MOCK_ASK_PERMISSION"); await page.keyboard.press("Enter"); await sleep(4000)
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
    await t.page.screenshot({ path: S + "/work/x-b6-inbox.png" })
    await t.cap("Approve a prompt without leaving the couch.")
    await sleep(1200)
    const approve = t.page.locator("button:text-is('Yes') >> visible=true").first()
    await t.click(approve); await sleep(3000)
    await t.page.screenshot({ path: S + "/work/x-b6-after-yes.png" })
    await t.cap("See what it all cost.")
    await t.click(t.page.locator("text=Analytics >> visible=true").last()); await sleep(3000)
    for (let i = 0; i < 4; i++) { await t.page.mouse.wheel(0, 380); await sleep(900) }
    await t.page.screenshot({ path: S + "/work/x-b6-analytics.png" })
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
