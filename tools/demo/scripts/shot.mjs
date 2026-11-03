import { chromium, S, PORT } from "./lib.mjs"
// usage: DEMO_ROOT=... node shot.mjs <path> <out.png> [width] [height]: a headless screenshot of one dashboard page
const [,, path, out, w = "1440", h = "900"] = process.argv
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: +w, height: +h } })
const page = await ctx.newPage()
await page.goto("http://127.0.0.1:" + PORT + path, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(4000)
await page.screenshot({ path: out })
console.log(page.url())
await browser.close()
