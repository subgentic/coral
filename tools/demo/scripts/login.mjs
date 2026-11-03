// Sign in to the demo Coral with its one-time link, headless, and save the session for the takes (work/state.json).
import { chromium, S, BASE } from "./lib.mjs"
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
await page.goto(process.argv[2], { waitUntil: "domcontentloaded" })
await page.waitForTimeout(4000)
await ctx.storageState({ path: S + "/work/state.json" })
console.log(await page.title(), page.url().replace(/login_token=.*/, "login_token=X"))
await browser.close()
