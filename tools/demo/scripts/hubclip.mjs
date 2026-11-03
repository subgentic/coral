import { chromium, S } from "./lib.mjs"
// a fresh, empty profile: no cookies, no account. Only loads and scrolls the public page.
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: S + "/work/clips/hub", size: { width: 1440, height: 900 } } })
const page = await ctx.newPage()
await page.goto("https://coralhub.dev", { waitUntil: "domcontentloaded", timeout: 30000 })
await page.waitForTimeout(2500)
await page.screenshot({ path: S + "/work/clips/hub-top.png" })
await page.mouse.wheel(0, 500); await page.waitForTimeout(1500)
await page.mouse.wheel(0, 500); await page.waitForTimeout(1500)
console.log(page.url(), await page.title())
await ctx.close(); await browser.close()
