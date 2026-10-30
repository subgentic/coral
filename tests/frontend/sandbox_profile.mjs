// The test server's home, all of it (#375). HOME alone is not where a program on Windows finds its home: Go's os.UserHomeDir reads
// USERPROFILE, PowerShell keeps its PSReadLine history under APPDATA, npm and the agents' CLIs read APPDATA and LOCALAPPDATA. With only
// HOME moved, a Windows test server indexed the operator's real ~/.claude/projects, merged their real ~/.claude/settings.json into every
// launch, and every PTY launch line went into their real PowerShell history (918 lines with a coral-cdp- folder were found there).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// profileEnv is what a test server gets so that everything it (and the agents, hooks and shells it starts) calls home is hostHome.
export function profileEnv(hostHome, platform = process.platform) {
  const env = {
    HOME: hostHome,
    CLAUDE_CONFIG_DIR: path.join(hostHome, '.claude'), // a real claude CLI (a fallback) keeps its config and transcripts here, not in ~/.claude
    XDG_CONFIG_HOME: path.join(hostHome, '.config'), XDG_DATA_HOME: path.join(hostHome, '.local', 'share'),
    XDG_CACHE_HOME: path.join(hostHome, '.cache'), XDG_STATE_HOME: path.join(hostHome, '.local', 'state'),
  };
  if (platform === 'win32') {
    const { root } = path.win32.parse(hostHome);
    Object.assign(env, {
      USERPROFILE: hostHome,
      HOMEDRIVE: root.replace(/\\$/, ''), HOMEPATH: hostHome.slice(root.length - 1),
      APPDATA: path.join(hostHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(hostHome, 'AppData', 'Local'),
    });
  }
  for (const k of ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (env[k]) fs.mkdirSync(env[k], { recursive: true });
  }
  return env;
}

// writeStub puts a stand-in for cli in binDir (#4354): it always exits 1, so a real CLI never runs, and once readyPath exists it adds
// "<cli> <args>" to marker. Windows finds a program on PATH only by a PATHEXT extension, so the sh file alone was never found there and a
// fallback ran the operator's real CLI (#375): the same stub as a .cmd too.
export function writeStub(binDir, cli, readyPath, marker, platform = process.platform) {
  fs.writeFileSync(path.join(binDir, cli),
    `#!/bin/sh\n[ -e "${readyPath}" ] && printf '%s %s\\n' "${cli}" "$*" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  // Only the program's name: its arguments, put on a cmd.exe command line, would be run by it (an unquoted & | >) or redirected.
  if (platform === 'win32') {
    fs.writeFileSync(path.join(binDir, cli + '.cmd'), `@echo off\r\nif exist "${readyPath}" (echo ${cli} was called)>> "${marker}"\r\nexit /b 1\r\n`);
  }
}

// realProfile is where the operator's own agent folders and PowerShell history are, read from this (the runner's) environment.
export function realProfile(env = process.env, platform = process.platform) {
  const home = (platform === 'win32' && env.USERPROFILE) || os.homedir();
  const appData = platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming')) : '';
  return {
    trees: ['.claude', '.codex', '.gemini', '.pi', '.coral'].map(d => path.join(home, d)),
    files: [path.join(home, '.claude.json'), ...(appData ? [path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')] : [])],
  };
}

// profileLeaks names every place in the operator's profile that this run reached: a file or folder whose name carries the run folder's
// name (a real CLI that ran in the run's folder files its transcript under a folder named after it) changed since the run started, and
// any line of the profile's own files (~/.claude.json, the PowerShell history) that names it. Names only, never what the files say.
export function profileLeaks(token, since, profile = realProfile()) {
  const leaks = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name.includes(token)) {
        try { if (fs.lstatSync(p).mtimeMs >= since) leaks.push(p); } catch { /* gone */ }
      }
      if (e.isDirectory() && !e.isSymbolicLink() && depth < 4) walk(p, depth + 1);
    }
  };
  for (const t of profile.trees) walk(t, 0);
  for (const f of profile.files) {
    let text;
    try { if (fs.statSync(f).mtimeMs < since) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const n = text.split('\n').filter(l => l.includes(token)).length;
    if (n) leaks.push(`${f}: ${n} line(s) name this run's folder`);
  }
  return leaks;
}
