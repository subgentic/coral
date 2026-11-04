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
import { readFileSync } from "node:fs"
export const story = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../story.json"), "utf8"))   // the example the film tells: team, agents, goal, documents, code change
export const PORT = process.env.DEMO_PORT || "8471"
if (PORT === "8420") throw new Error("refusing port 8420")
const require = createRequire(S + "/package.json")
export const { chromium } = require("playwright")
export const BASE = "http://127.0.0.1:" + PORT
const keyFile = S + "/work/key"
export const key = () => fs.readFileSync(keyFile, "utf8").trim()   // read when needed: rig-up writes it after the project is made
export const OPEN = []
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const agent = (name, ...args) => execFileSync(HERE + "/asagent.sh", [name, ...args], { encoding: "utf8" })
export async function launchTeam() {
  const r = await fetch(BASE + "/api/sessions/launch-team", { method: "POST", headers: { Authorization: "Bearer " + key(), "Content-Type": "application/json" },
    body: JSON.stringify({ board_name: story.team, working_dir: REPO, agents: story.agents.map((n) => ({ agent_type: "claude", name: n, prompt: (story.agentPrompts && story.agentPrompts[n]) || "Sample agent." })) }) })
  const j = await r.json(); fs.writeFileSync(S + "/work/launch.json", JSON.stringify(j)); return j
}
// one recorded context per beat; a caption band and a visible cursor are injected into every page
export async function beat(browser, name, { w = 1600, h = 900, mobile = false } = {}) {
  const dir = S + "/work/clips/" + name
  fs.rmSync(dir, { recursive: true, force: true })
  const ctx = await browser.newContext({ storageState: S + "/work/state.json", viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile,
    recordVideo: { dir, size: { width: w, height: h } } })
  // Leak check: while a beat runs, the page is scanned twice a second (text that is in the frame, tooltips and placeholders) for anything that
  // would give away the machine it was made on or an internal id: the host's home folder, the scratch folder, an agent scratchpad, a session id, a board id (b- and 8 or more letters or digits), a long hex digest, a coral:// link.
  const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }
  const needles = [...new Set([os.homedir(), real(os.homedir()), "/claude-501/", "scratchpad", "/private/var/folders"].filter((x) => x && x.length >= 4))]
  const needleSrc = needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  await ctx.addInitScript((src) => {
    window.__leaks = []
    const re = new RegExp(src.join("|") + "|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\\bb-[a-z0-9]{8,}\\b|\\b[0-9a-f]{32,}\\b|coral://", "i")   // session ids, board ids (b-xxxxxxxx), digests and artifact links
    // only what is inside the frame counts: a text node with a box that meets the viewport, and elements shown there (a message scrolled out of view is not on camera)
    const onScreen = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    // text a screen reader gets but nobody sees (the usual sr-only clip, a 1px box) is not on camera
    const hidden = (el) => { for (let e = el, i = 0; e && i < 6; e = e.parentElement, i++) { const cs = getComputedStyle(e); if ((cs.position === "absolute" && cs.clip && cs.clip !== "auto") || (cs.clipPath && cs.clipPath.startsWith("inset(50%")) || (e.offsetWidth <= 1 && e.offsetHeight <= 1 && cs.overflow !== "visible")) return true } return false }
    const scan = () => {
      if (!document.body) return
      const bits = [], range = document.createRange(), walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim() || !n.parentElement || (n.parentElement.checkVisibility && !n.parentElement.checkVisibility()) || hidden(n.parentElement)) continue
        range.selectNodeContents(n); if ([...range.getClientRects()].some(onScreen)) bits.push(n.nodeValue)
      }
      for (const el of document.querySelectorAll("[title],[placeholder]")) if (onScreen(el.getBoundingClientRect()) && !hidden(el)) bits.push(el.title, el.getAttribute("placeholder"))   // aria-labels are not painted: a screen reader reads them, the film does not show them
      const txt = bits.filter(Boolean).join("\n"), m = re.exec(txt)
      if (m) { const hit = m[0] + "  [in: " + txt.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50).replace(/\s+/g, " ") + "]"; if (!window.__leaks.some((x) => x.startsWith(m[0]))) window.__leaks.push(hit) }
    }
    setInterval(scan, 500)
  }, needleSrc)
  await ctx.addInitScript(() => {
    const mk = () => {
      if (document.getElementById("__cap")) return
      const st = document.createElement("style"); st.textContent = "#__cap{pointer-events:none;position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 24px;text-align:center;font:600 22px/1.3 system-ui,sans-serif;color:#e7ebf2;background:rgba(14,17,22,.92);opacity:0}@media(max-width:500px){#__cap{bottom:78px;font-size:16px;padding:10px 14px;margin:0 8px;border-radius:10px}}#__cur{position:fixed;z-index:2147483647;width:18px;height:18px;border-radius:50%;background:rgba(79,140,255,.85);border:2px solid #fff;pointer-events:none;transform:translate(-9px,-9px);left:-40px;top:-40px;transition:left .02s,top .02s}"
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

// A themed permission prompt or question from a mock agent: the same hook events the mock fires for MOCK_ASK_PERMISSION and MOCK_ASK_QUESTION,
// but with the text the story wants. The hook commands come from the agent's own settings; they run as that agent.
export function fireHook(agentName, event, extra) {
  const launch = JSON.parse(fs.readFileSync(S + "/work/launch.json", "utf8")).agents.find((a) => a.name === agentName)
  const handed = fs.readFileSync(S + "/work/envdump/" + launch.session_id + ".handed", "utf8")
  const settings = JSON.parse(handed.slice(handed.indexOf("{")))
  const cmds = (settings.hooks[event] || []).flatMap((g) => g.hooks.filter((h) => h.type === "command").map((h) => h.command))
  const payload = JSON.stringify({ session_id: launch.session_id, hook_event_name: event, cwd: REPO, transcript_path: "", ...extra })
  for (const c of cmds) {
    const words = [...c.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
    execFileSync(HERE + "/asagent.sh", [agentName, ...words], { input: payload, encoding: "utf8" })
  }
}
export const askPermission = (agentName, command, description) => {
  fireHook(agentName, "PermissionRequest", { tool_name: "Bash", tool_use_id: "toolu_demo_" + Math.random().toString(36).slice(2, 8), tool_input: { command, description } })
  fireHook(agentName, "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" })
}
export const askQuestion = (agentName, header, question, options) =>
  fireHook(agentName, "PermissionRequest", { tool_name: "AskUserQuestion", tool_use_id: "toolu_demo_q_" + Math.random().toString(36).slice(2, 8), tool_input: { questions: [{ header, multiSelect: false, question, options: options.map((o) => ({ label: o[0], description: o[1] })) }] } })
