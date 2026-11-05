import fs from "node:fs"
import { OPEN, key, chromium, beat, sleep, agent, BASE, S, SEED, REPO, HERE, story } from "./lib.mjs"
process.env.CORAL_TELEMETRY_DISABLED = "1"
// Demo film v8: the story in the Operator's order: welcome, create a team, give it a goal, the work divided among the agents with their artifacts,
// talk to the goal's driver, answer an agent in the Inbox, review a file, analytics. Beats are recorded (d1..); steps are not.
//   NOLAUNCH=1 rig-up.sh; node take8.mjs d1; ...   (see ../README.md)
const which = process.argv.slice(2)
const browser = await chromium.launch({ headless: true })
const out = {}
const { goal, live, goalChat } = story
const WORKERS = story.v8.workers
const uploadOf = (r) => JSON.parse(r.split("\n").find((l) => l.startsWith("{")))
const lj = () => JSON.parse(fs.readFileSync(S + "/work/launch.json", "utf8"))
const sid = (name) => lj().agents.find((a) => a.name === name).session_id
const board = (...a) => agent("Orchestrator", "coral-board", ...a)
const goalId = (title) => JSON.parse(board("goal", "list", "--state", "all", "--json")).find((g) => g.title === title)?.id
const taskId = (title) => JSON.parse(board("task", "list", "--json")).find((x) => x.title === title)?.id
// type into a box by growing its value with the page's own input events (keys sent to some panels' boxes do not land in them in a recording)
const typeInto = async (t, box, text, ms = 22) => { await t.move(box); for (const ch of text) { await box.evaluate((el, c) => { el.value += c; el.dispatchEvent(new Event("input", { bubbles: true })) }, ch); await sleep(ms) } }
const pclick = async (t, loc) => { await t.move(loc); await loc.evaluate((el) => el.click()) }
const shot = async (t, name) => t.page.screenshot({ path: S + "/work/x-" + name + ".png" }).catch(() => {})
const B = {
  async d1() { // Welcome to the Inbox, then a team created on screen: name, folder, members (one agent's model list), the first task, Launch
    const t = await beat(browser, "d1")
    await t.go("/inbox/needs"); await t.cap("Welcome to the Inbox for your agents."); await sleep(3200)
    await t.click(t.page.locator("button:text-is('Agents'), a:text-is('Agents')").first()); await sleep(1500)
    await t.cap("Start with a team, not a single agent.")
    await t.click(t.page.locator("button[data-arg=team] >> visible=true").first()); await sleep(1200)
    const name = t.page.getByPlaceholder("e.g. auth-feature").locator("visible=true").first()
    await t.click(name); await t.page.keyboard.type(story.team, { delay: 70 }); await sleep(500)
    await t.cap("Name the team. Its agents work in one folder.")
    await sleep(1200)
    await t.click(t.page.locator("button:text-is('Next') >> visible=true").first()); await sleep(1400)
    await t.cap("A team is a set of agents with roles. The Orchestrator plans and hands out the work.")
    await sleep(2200)
    // (the Edit member screen and its model list are out, at the Operator's word)
    await t.click(t.page.locator("button:text-is('Next') >> visible=true").first()); await sleep(1200)
    await t.cap("Tell the team what to work on. It goes to the Orchestrator first.")
    const first = t.page.getByPlaceholder(/For example: build/).locator("visible=true").first()
    await t.click(first); await t.page.keyboard.type("Plan the first week for Skyline, a five-day weather forecast app.", { delay: 35 }); await sleep(600)
    // the goal comes next, as its own step: do not also save this one as the team's goal (the switch is found from its label, climbing to the control beside it)
    const sw = await t.page.evaluate(() => {
      const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && /Also save this/.test(e.textContent || "")); let n = el
      for (let i = 0; n && i < 6; i++, n = n.parentElement) {
        const c = n.querySelector("input[type=checkbox],[role=switch],[role=checkbox],button[aria-pressed],button[aria-checked]")
        if (c) { const on = c.checked === true || c.getAttribute("aria-checked") === "true" || c.getAttribute("aria-pressed") === "true"; if (on) c.click(); return (on ? "turned off " : "already off ") + c.tagName }
      }
      return "not found"
    })
    console.error("team goal switch: " + sw)
    await sleep(800)
    await t.cap("Launch it. The agents start together.")
    await sleep(1000)
    await t.click(t.page.locator("button:text-is('Launch team') >> visible=true").first()); await sleep(4500)
    await t.cap("Every agent is on your list, on one shared board.")
    await sleep(3000)
    return t.finish()
  },
  async sync() { // not recorded: the team was started from the dashboard; write launch.json (the agents' session ids) from the live sessions
    const L = await (await fetch(BASE + "/api/sessions/live", { headers: { Authorization: "Bearer " + key() } })).json()
    const agents = L.filter((x) => x.board_label === story.team && !x.archived).map((x) => ({ name: x.board_subscriber_id, session_id: x.session_id }))
    if (agents.length < 3) throw new Error("the team is not up: " + JSON.stringify(agents))
    fs.writeFileSync(S + "/work/launch.json", JSON.stringify({ ok: true, agents })); return JSON.stringify(agents.map((a) => a.name))
  },
  async d2() { // give the team a goal: a name, a description, a done-when and a picture
    const t = await beat(browser, "d2")
    // from the team's own page: its Goals tab, then New goal, so it is plain that the goal goes to this team
    await t.go("/agents"); await t.cap("Now give the team a goal.")
    await t.click(t.page.locator(`text=${story.team} >> visible=true`).first()); await sleep(1500)
    await t.click(t.page.getByRole("tab", { name: /^Goals/ }).or(t.page.locator("button:text-is('Goals'), a:text-is('Goals')")).locator("visible=true").first()); await sleep(1500)
    await t.cap("Create a new goal, in plain words.")
    await t.click(t.page.locator("button:has-text('New goal') >> visible=true").first()); await sleep(1200)
    const title = t.page.getByPlaceholder("Name the goal"); await t.click(title); await t.page.keyboard.type(goal.title, { delay: 40 }); await sleep(500)
    const body = t.page.locator("[contenteditable=true]:visible, textarea:visible").first(); await t.click(body)
    for (const [i, line] of goal.body.entries()) { if (i > 1) await t.page.keyboard.press("Enter"); await t.page.keyboard.type(i === 1 ? "- " + line : line, { delay: 12 }); if (i === 0) await t.page.keyboard.press("Enter") }
    await sleep(600)
    const done = t.page.getByPlaceholder("What a person can check"); await t.click(done); await t.page.keyboard.type(goal.done, { delay: 25 }); await sleep(600)
    await t.cap("Add a picture, a mock-up or a screenshot.")
    const zone = t.page.locator("text=Drop, paste or choose >> visible=true").first(); await t.move(zone); await sleep(500)
    const b64 = fs.readFileSync(SEED + "/" + goal.picture).toString("base64")
    await t.page.evaluate(([data, name]) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], name, { type: "image/png" }))
      let el = [...document.querySelectorAll("*")].filter((e) => /Drop, paste or choose/.test(e.textContent || "") && e.getBoundingClientRect().height < 220 && e.getBoundingClientRect().width > 0).pop()
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, [b64, goal.picture]); await sleep(1300)
    if (!(await t.page.getByText(/pictures\s*[·•-]\s*[1-9]/i).count().then((n) => n > 0).catch(() => false))) { await t.page.locator("input[type=file]").first().setInputFiles(SEED + "/" + goal.picture); await sleep(1500) }
    await t.cap("The guide sizes it as you write.")
    await sleep(1800)
    await t.click(t.page.locator("button:has-text('Create goal') >> visible=true").first()); await t.cap(""); await sleep(1500)
    return t.finish()
  },
  async d3() { // the work divided: the Orchestrator hands out tasks, each agent takes its own, what they make is attached to the tasks. The page stays at the bottom: tasks, artifacts, comments.
    const gid = goalId(goal.title); if (!gid) throw new Error("the goal is not there")
    const plan = [["Write the forecast contract", WORKERS[0], "forecast-api.md"], ["Measure the forecast error", WORKERS[1], "accuracy.csv"], ["Build the five-day forecast cards", WORKERS[0], null], ["Write the beta test plan", WORKERS[1], "test-plan.md"], ["Add the units switch", WORKERS[0], null]]
    const t = await beat(browser, "d3")
    const bottom = async () => { await t.page.mouse.move(900, 500); await t.page.mouse.wheel(0, 3000); await sleep(450) }   // the page grows as rows arrive: back to the bottom each time
    await t.go("/inbox/goals"); await t.cap("The Orchestrator is the goal's driver. It splits the goal into tasks.")
    await t.click(t.page.locator(`text=${goal.title} >> visible=true`).first()); await sleep(1200)
    await bottom()
    for (const [title, who] of plan) { board("task", "add", title, "--goal", String(gid), "--assignee", who); await sleep(700); await bottom() }
    await t.cap("Each task goes to an agent. They work in parallel."); await sleep(1500)
    for (const [title, who, file] of plan) {
      const id = taskId(title)
      try { agent(who, "coral-board", "task", "claim", String(id)) } catch (e) { console.error("claim failed: " + title) }
      if (file) { fs.writeFileSync(S + "/work/att-" + file, fs.readFileSync(SEED + "/" + file, "utf8") + "\n(" + title + ", " + Date.now() + ")\n"); try { agent(who, "coral-agent", "artifact", "upload", S + "/work/att-" + file, "--name", file, "--task", String(id)) } catch (e) { console.error("upload failed: " + file) } }
      try { agent(who, "coral-board", "task", "complete", String(id), "--message", "Done.") } catch (e) { console.error("complete failed: " + title) }
      await bottom()
    }
    await sleep(1200)
    await t.cap("What they make is attached to their tasks.")
    await t.click(t.page.locator("text=Artifacts >> visible=true").last()); await sleep(700); await bottom(); await sleep(1200)
    await t.click(t.page.locator("text=/forecast-api|accuracy|test-plan/ >> visible=true").first()); await sleep(3000)
    await t.page.keyboard.press("Escape"); await sleep(600)
    await t.cap("And you can comment on the goal right there.")
    await t.click(t.page.locator("text=Comments >> visible=true").last()); await sleep(700); await bottom(); await sleep(2200)
    return t.finish()
  },
  async d4() { // talk to the goal's driver in its chat: a question, and a real update back
    const t = await beat(browser, "d4")
    await t.go("/agents/" + sid("Orchestrator")); await t.cap("Talk to the driver of the goal. It is an agent: ask it where things stand.")
    await sleep(1200)
    const box = t.page.getByPlaceholder(/Message Orchestrator/); await t.click(box)
    await typeInto(t, box, goalChat.prompt, 24); await sleep(500)
    await t.page.keyboard.press("Enter")
    await sleep(2500); await shot(t, "d4-sent")
    await t.page.locator("text=Update on the forecast goal >> visible=true").first().waitFor({ state: "visible", timeout: 20000 }).catch(async (e) => { await shot(t, "d4-noreply"); throw e })
    await t.cap("It answers with the state of the work.")
    await sleep(4500)
    return t.finish()
  },
  async ask() { // not recorded: an agent raises a question (the mock does it when asked), to be answered in the Inbox
    const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: 1600, height: 900 } }); const page = await ctx.newPage()
    await page.goto(BASE + "/agents/" + sid(story.v8.askAgent), { waitUntil: "domcontentloaded" }); await sleep(2500)
    const box = page.getByPlaceholder(new RegExp("Message " + story.v8.askAgent)); await box.click(); await page.keyboard.type("MOCK_ASK_QUESTION"); await page.keyboard.press("Enter"); await sleep(4000)
    await ctx.close(); return "asked"
  },
  async d5() { // the Inbox: the agent's question, opened and answered there
    const t = await beat(browser, "d5")
    await t.go("/inbox/needs"); await t.cap("Back in the Inbox: an agent is waiting on you.")
    await sleep(1200)
    const row = t.page.locator("text=Celsius or Fahrenheit >> visible=true").first()
    await t.cap("Open the question to read it in full."); await t.move(row, 40); await sleep(1200)
    const bb = await row.boundingBox(); await t.page.mouse.click(bb.x + 40, bb.y + 8); await sleep(3200)
    await t.cap("Answer it right there.")
    await t.click(t.page.getByText("Celsius", { exact: true }).locator("visible=true").first()); await sleep(2500)
    return t.finish()
  },
  async d6() { // a file to review: open it from the Inbox, comment, the agent answers with a new draft, approve it
    fs.writeFileSync(S + "/work/live.md", fs.readFileSync(SEED + "/" + live.file, "utf8") + "\n<!-- take " + Date.now() + " -->\n")
    const who = story.v8.docAgent
    const up = uploadOf(agent(who, "coral-agent", "artifact", "upload", S + "/work/live.md", "--name", live.name, "--tag", "for review", "--question", live.question))
    await sleep(1500)
    const t = await beat(browser, "d6")
    await t.go("/inbox/needs")
    const row = t.page.locator(`text=${live.name} >> visible=true`).first()
    await row.waitFor({ state: "visible", timeout: 12000 })
    await t.cap("A file an agent wants reviewed waits in your Inbox."); await sleep(1500)
    await t.move(row, 35); await sleep(500); await t.cap(""); await row.click(); await sleep(2200)
    await t.cap("Read it with everything it says.")
    await t.page.mouse.wheel(0, 500); await sleep(2200); await t.page.mouse.wheel(0, -500); await sleep(800)
    await t.click(t.page.getByRole("button", { name: /^Comments/ })); await sleep(900)
    await pclick(t, t.page.locator("button.ac-whole >> visible=true").first()); await sleep(700)
    const box = t.page.locator(".ac-composer .ac-input >> visible=true").first()
    await t.cap("Comment on it.")
    await typeInto(t, box, live.comment, 18); await sleep(400)
    await pclick(t, t.page.locator(".ac-composer button >> visible=true").filter({ hasText: /^Comment$/ }).first())
    await sleep(300)
    const link = up.series_id ? "coral://artifacts/series/" + up.series_id : up.uri
    let id; for (let k = 0; k < 40 && !id; k++) { await sleep(150); try { id = (agent(who, "coral-agent", "artifact", "comments", link).match(/Thread (\d+)/) || [])[1] } catch (e) { /* not asked in yet */ } }
    if (!id) throw new Error("the comment never reached the agent")
    let txt = fs.readFileSync(S + "/work/live.md", "utf8"); for (const [a, b] of live.edits) txt = txt.replace(a, b); fs.writeFileSync(S + "/work/live.md", txt)
    // The open file does not take new comments live (asked of the Orchestrator), so the film cuts here: the agent answers and uploads the new draft, the file is closed and opened again, outside the take.
    t.cutStart()
    agent(who, "coral-agent", "artifact", "reply", link, id, live.reply)
    agent(who, "coral-agent", "artifact", "upload", S + "/work/live.md", "--name", live.name, "--new-version-of", link, "--tag", "for review", "--question", live.question2)
    await t.click(t.page.locator("button:text-is('Close') >> visible=true").last()); await sleep(1200)
    await t.click(t.page.locator(`text=${live.name} >> visible=true`).first()); await sleep(2000)
    await sleep(1200)
    const seenNow = (ms) => t.page.locator(`text=${live.replyFind}`).first().waitFor({ state: "visible", timeout: ms }).then(() => true).catch(() => false)
    let ok = await seenNow(600)
    for (let k = 0; k < 3 && !ok; k++) { await t.click(t.page.getByRole("button", { name: /^Comments/ })); ok = await seenNow(3000) }
    t.cutEnd()
    if (!ok) { await shot(t, "d6-noreply"); throw new Error("the agent's answer never showed on screen") }
    await t.cap("The agent answers, and sends a new draft.")
    await sleep(2500)
    await t.click(t.page.getByRole("button", { name: /v\d+ of \d+/ }).first()); await sleep(800)
    await t.click(t.page.getByText("Open the latest").first()); await sleep(1800)
    await t.cap("Happy with the draft? Approve it.")
    await pclick(t, t.page.locator("button:text-is('Approve') >> visible=true").last()); await sleep(2500)   // the dialog's own button (the Inbox row behind it has one too)   // the comment panel's note sits over the button: press with the page's own click
    return t.finish()
  },
  async d7() { // Analytics: totals, the spend chart, cost by provider, model and team
    const t = await beat(browser, "d7")
    await t.page.addInitScript(() => setInterval(() => document.querySelectorAll("[class*=toast]").forEach((e) => e.remove()), 150))   // a restart notice from re-opening the rig is not part of the story
    await t.go("/analytics"); await sleep(600)
    const range = t.page.locator("select:has(option)").filter({ has: t.page.locator("option", { hasText: /7 days|week/i }) }).first()   // the time range: a week, so the invented history shows
    if (await range.count()) { const label = await range.evaluate((el) => [...el.options].find((o) => /7 days|week/i.test(o.text))?.text); await t.move(range); await range.selectOption({ label }); await sleep(3500) } else await shot(t, "c9-norange")
    await t.cap("What did the team cost? A week, by day.")
    await sleep(2500)
    await t.page.mouse.move(900, 500, { steps: 15 }); await t.page.mouse.wheel(0, 450); await t.cap("By provider, model and team."); await sleep(3500)
    await t.page.mouse.wheel(0, 450); await sleep(3500)
    return t.finish()
  },}
for (const n of which) {
  if (!B[n]) { console.error("unknown beat " + n); continue }
  try { out[n] = await B[n]() } catch (e) { console.error("FAILED " + n + ": " + String(e.message || e).slice(0, 600)); out[n] = null }
}
for (const c of OPEN) await c.close().catch(() => {})
await browser.close()
console.log(JSON.stringify(out))
