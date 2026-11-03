// Story-driven setup, run by rig-up.sh: `node setup.mjs repo` makes the throwaway project, `node setup.mjs launch` launches the team.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { REPO, story, launchTeam } from "./lib.mjs"
process.env.CORAL_TELEMETRY_DISABLED = "1" // nothing here starts a Coral by itself; the line keeps the repo's telemetry census uniform
const what = process.argv[2]
if (what === "repo") {
  fs.mkdirSync(REPO, { recursive: true })
  const git = (...a) => execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", ...a], { cwd: REPO, stdio: "ignore" })
  git("init", "-q", "-b", "main", ".")
  for (const [f, text] of Object.entries(story.repo.initial)) fs.writeFileSync(path.join(REPO, f), text)
  git("add", "."); git("commit", "-qm", story.repo.commitMessage)
} else if (what === "launch") {
  const r = await launchTeam(); if (!r.ok) { console.error("launch failed"); process.exit(1) }
} else { console.error("usage: node setup.mjs repo|launch"); process.exit(2) }
