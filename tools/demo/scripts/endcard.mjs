// A plain end card (the alternative to ending on a live public page, which can go stale): 6 s, no Coral needed.
// usage: DEMO_ROOT=... node endcard.mjs   -> work/clips/endcard/*.webm ; encode.sh uses it with ENDING=card
import fs from "node:fs"
import { chromium, S, sleep } from "./lib.mjs"
process.env.CORAL_TELEMETRY_DISABLED = "1" // nothing here starts a Coral; the line keeps the repo's telemetry census uniform
const dir = S + "/work/clips/endcard"; fs.rmSync(dir, { recursive: true, force: true })
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir, size: { width: 1600, height: 900 } } })
const page = await ctx.newPage()
await page.setContent(`<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0e1116;color:#e7ebf2;font-family:system-ui,sans-serif;text-align:center">
<div><div style="font-size:84px;font-weight:700;letter-spacing:-.02em">Coral</div>
<div style="font-size:34px;color:#8b95a7;margin-top:14px">The Inbox for your agents.</div>
<div style="font-size:26px;color:#4f8cff;margin-top:46px">github.com/subgentic/coral</div></div></body>`)
await sleep(6000); await ctx.close(); await browser.close()
console.log(fs.readdirSync(dir).find((x) => x.endsWith(".webm")))
