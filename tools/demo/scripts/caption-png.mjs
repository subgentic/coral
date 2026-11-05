import { chromium, S } from "./lib.mjs"
// usage: DEMO_ROOT=... node caption-png.mjs "<caption>" <out.png>: a 1920x1080 transparent PNG with the film's caption band (same look as the captions the takes draw), to lay over a clip that is not a take
const [, , text, out] = process.argv
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.setContent(`<!doctype html><meta charset=utf-8><body style="margin:0;background:transparent"><div style="position:fixed;inset:auto 0 0 0;padding:17px 29px;text-align:center;font:600 26px/1.3 system-ui,sans-serif;color:#e7ebf2;background:rgba(14,17,22,.92)"></div>`)
await page.evaluate((t) => { document.querySelector("div").textContent = t }, text)
await page.screenshot({ path: out, omitBackground: true })
await browser.close()
