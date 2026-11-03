import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
process.env.CORAL_TELEMETRY_DISABLED = "1" // the demo Coral and everything the takes start send no usage events
export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SEED = path.resolve(HERE, "../seed")
if (!process.env.DEMO_ROOT) throw new Error("set DEMO_ROOT to a scratch folder")
export const S = path.resolve(process.env.DEMO_ROOT)
if (S === "/" || S === process.env.HOME || !fs.existsSync(S + "/.coral-demo-root")) throw new Error("refusing DEMO_ROOT " + S + ": make a folder for the demo and touch .coral-demo-root in it (see the README)")
export const REPO = S + "/home/projects/demo-app"
export const PORT = process.env.DEMO_PORT || "8471"
if (PORT === "8420") throw new Error("refusing port 8420")
const require = createRequire(S + "/package.json")
export const { chromium } = require("playwright")
export const BASE = "http://127.0.0.1:" + PORT
export const KEY = fs.readFileSync(S + "/work/key", "utf8").trim()
export const OPEN = []
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const agent = (name, ...args) => execFileSync(HERE + "/asagent.sh", [name, ...args], { encoding: "utf8" })
export async function launchTeam() {
  const r = await fetch(BASE + "/api/sessions/launch-team", { method: "POST", headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ board_name: "slug-team", working_dir: REPO, agents: ["Orchestrator", "Developer", "Reviewer"].map((n) => ({ agent_type: "claude", name: n, prompt: "Sample agent." })) }) })
  const j = await r.json(); fs.writeFileSync(S + "/work/launch.json", JSON.stringify(j)); return j
}
// one recorded context per beat; a caption band and a visible cursor are injected into every page
export async function beat(browser, name, { w = 1600, h = 900, mobile = false } = {}) {
  const dir = S + "/work/clips/" + name
  fs.rmSync(dir, { recursive: true, force: true })
  const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile,
    recordVideo: { dir, size: { width: w, height: h } } })
  // Leak check: while a beat runs, the page is scanned twice a second (visible text, titles, aria-labels, placeholders) for anything that
  // would give away the machine it was made on: the host's home folder or user name, the scratch folder, an agent scratchpad, a session id.
  const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }
  const needles = [...new Set([os.homedir(), real(os.homedir()), "/claude-501/", "scratchpad", "/private/var/folders"].filter((x) => x && x.length >= 4))]
  const needleSrc = needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  await ctx.addInitScript((src) => {
    window.__leaks = []
    const re = new RegExp(src.join("|") + "|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "i")
    const scan = () => {
      const bits = [document.body ? document.body.innerText : ""]
      for (const el of document.querySelectorAll("[title],[aria-label],[placeholder],[alt]")) bits.push(el.title, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("alt"))
      const m = re.exec(bits.filter(Boolean).join("\n")); if (m && !window.__leaks.includes(m[0])) window.__leaks.push(m[0])
    }
    setInterval(scan, 500)
  }, needleSrc)
  await ctx.addInitScript(() => {
    const mk = () => {
      if (document.getElementById("__cap")) return
      const st = document.createElement("style"); st.textContent = "#__cap{pointer-events:none;position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 24px;text-align:center;font:600 22px/1.3 system-ui,sans-serif;color:#e7ebf2;background:rgba(14,17,22,.92);transition:opacity .18s;opacity:0}@media(max-width:500px){#__cap{bottom:78px;font-size:16px;padding:10px 14px;margin:0 8px;border-radius:10px}}#__cur{position:fixed;z-index:2147483647;width:18px;height:18px;border-radius:50%;background:rgba(79,140,255,.85);border:2px solid #fff;pointer-events:none;transform:translate(-9px,-9px);left:-40px;top:-40px;transition:left .02s,top .02s}"
      document.documentElement.append(st)
      const c = document.createElement("div"); c.id = "__cap"; document.documentElement.append(c)
      const k = document.createElement("div"); k.id = "__cur"; document.documentElement.append(k)
      addEventListener("mousemove", (e) => { k.style.left = e.clientX + "px"; k.style.top = e.clientY + "px" }, true)
    }
    document.addEventListener("DOMContentLoaded", mk); mk()
  })
  OPEN.push(ctx)
  const page = await ctx.newPage()
  const cap = async (t) => page.evaluate((t) => { const c = document.getElementById("__cap"); if (!c) return; c.textContent = t || ""; c.style.opacity = t ? 1 : 0 }, t)
  const go = async (path) => { await page.goto(BASE + path, { waitUntil: "domcontentloaded" }); await sleep(1500) }
  const move = async (loc, steps = 25) => { await loc.waitFor({ state: "visible", timeout: 15000 }); const b = await loc.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps }); await sleep(250); return b }
  const click = async (loc) => { await move(loc); await loc.click() }
  const finish = async () => { const leaks = await page.evaluate(() => window.__leaks || []).catch(() => []); await ctx.close(); if (leaks.length) throw new Error("leak on screen in " + name + ": " + leaks.join(" | ")); const f = fs.readdirSync(dir).find((x) => x.endsWith(".webm")); return dir + "/" + f }
  return { page, ctx, cap, go, move, click, finish }
}
