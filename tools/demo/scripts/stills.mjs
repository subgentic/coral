import fs from "node:fs"
import { chromium, beat, sleep, agent, S, SEED, story } from "./lib.mjs"
process.env.CORAL_TELEMETRY_DISABLED = "1"
// The two README stills (1600 px wide, sample data): the review space with a file at version 2 of 2, and Compare.
// usage: DEMO_ROOT=... node stills.mjs <outdir>   (needs a rig with the team launched: rig-up.sh)
const outDir = process.argv[2] || S + "/out"
fs.mkdirSync(outDir, { recursive: true })
const { live } = story
const uploadOf = (r) => JSON.parse(r.split("\n").find((l) => l.startsWith("{")))
const browser = await chromium.launch({ headless: true })
fs.copyFileSync(SEED + "/" + live.file, S + "/work/stills.md")
try { // a second run on the same rig finds the file already there (the same bytes are refused): use it
  const up = uploadOf(agent(live.agent, "coral-agent", "artifact", "upload", S + "/work/stills.md", "--name", live.name, "--tag", "for review", "--question", live.question))
  fs.writeFileSync(S + "/work/stills.md", fs.readFileSync(S + "/work/stills.md", "utf8").replace(live.from, live.to))
  agent(live.agent, "coral-agent", "artifact", "upload", S + "/work/stills.md", "--name", live.name, "--new-version-of", up.uri, "--tag", "for review", "--question", live.question2)
} catch (e) { console.error("upload skipped: " + String(e.message).split("\n")[0]) }
const t = await beat(browser, "stills")
try {
  await t.go("/inbox/needs"); await sleep(3500)
  await t.page.reload({ waitUntil: "domcontentloaded" }); await sleep(3000)
  await t.click(t.page.locator(`text=${live.name} >> visible=true`).first()); await sleep(2500)
  const bare = () => t.page.evaluate(() => { for (const id of ["__cur", "__cap"]) document.getElementById(id)?.remove() })
  await bare()
  await t.page.screenshot({ path: outDir + "/review-approve.png" })
  await t.click(t.page.getByRole("button", { name: /v2 of 2/ }).first()); await sleep(1500)
  await t.page.screenshot({ path: outDir + "/x-chip.png" })
  await t.click(t.page.getByText(/Compare/).first()); await sleep(2500); await bare()
  await t.page.screenshot({ path: outDir + "/review-compare.png" })
} finally { await t.finish().catch((e) => { console.error(String(e.message)); process.exitCode = 1 }) }
await browser.close()
