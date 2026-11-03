// Proves the on-screen leak check works without a Coral: a page that shows the host's home folder must fail, a clean page must pass.
// usage: DEMO_ROOT=... node selftest.mjs   (needs Playwright and Chromium in DEMO_ROOT, like the takes)
import fs from "node:fs"
import os from "node:os"
import { chromium, beat, sleep, S } from "./lib.mjs"
process.env.CORAL_TELEMETRY_DISABLED = "1" // nothing here starts a Coral; the line keeps the repo's telemetry census uniform
fs.mkdirSync(S + "/work", { recursive: true })
if (!fs.existsSync(S + "/work/state.json")) fs.writeFileSync(S + "/work/state.json", JSON.stringify({ cookies: [], origins: [] }))
const browser = await chromium.launch({ headless: true })
async function run(html) {
  const t = await beat(browser, "selftest")
  await t.page.setContent(html); await sleep(1300)
  try { await t.finish(); return "clean" } catch (e) { return "LEAK: " + e.message }
}
const clean = await run("<p>Agent in ~/projects/demo-app</p>")
const leaky = await run("<p title='x'>Folder " + os.homedir() + "/work/demo</p>")
const board = await run("<p>team b-v2ye7b5ue</p>")
const digest = await run("<p>sha " + "ab12".repeat(16) + "</p>")
const word = await run("<p>a b-tree and a b-side are words</p>")
const uuid = await run("<p>session 3ff4933c-1fe8-1854-145a-025cf4eb0844</p>")
await browser.close()
console.log("clean page:", clean); console.log("home folder:", leaky); console.log("session id:", uuid); console.log("board id:", board); console.log("digest:", digest); console.log("plain b- words:", word)
const ok = clean === "clean" && leaky.startsWith("LEAK") && uuid.startsWith("LEAK") && board.startsWith("LEAK") && digest.startsWith("LEAK") && word === "clean"
console.log(ok ? "selftest ok" : "selftest FAILED"); process.exit(ok ? 0 : 1)
