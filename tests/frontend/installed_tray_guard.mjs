// installed_tray_guard.mjs: a test run must never start the Coral that is INSTALLED on the machine (#5293). A Windows go test
// reached the real "start Coral again" of the updater and left the installed coral-tray.exe running, a tray icon and a second
// tray on the person's port each time (#234 fixes that path). The CDP runner lists the coral-tray.exe processes whose program
// is under Program Files before the run and after it, and fails the run when one appeared: the run's own servers are dev builds
// in its temp folder, never under Program Files. Windows only; elsewhere the list is empty and the check passes.
import { spawnSync } from './helpers/child_process.js';

/** The Program Files folders to treat as "installed", from the environment (lower case, no trailing separator). */
export function programDirs(env = process.env) {
  return [...new Set(['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']
    .map(k => env[k]).filter(Boolean).map(d => d.replace(/[\\/]+$/, '').toLowerCase()))];
}

/** The coral-tray.exe processes whose program sits under one of dirs. A process is { pid, path, started, command }. */
export function installedTrays(procs, dirs) {
  return procs.filter(p => {
    const exe = String(p.path || '').toLowerCase();
    return /(^|[\\/])coral-tray\.exe$/.test(exe) && dirs.some(d => exe.startsWith(d + '\\') || exe.startsWith(d + '/'));
  });
}

/** The installed trays in after that were not in before. A process is the same one only with the same pid AND start time, so a
 *  reused pid still counts as new. */
export function newInstalledTrays(before, after, dirs) {
  const key = p => `${p.pid}@${p.started}`;
  const seen = new Set(installedTrays(before, dirs).map(key));
  return installedTrays(after, dirs).filter(p => !seen.has(key(p)));
}

/** The coral-tray.exe processes now: [] off Windows. Throws when Windows cannot list them, so the check fails closed. */
export function listCoralTrays() {
  if (process.platform !== 'win32') return [];
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='coral-tray.exe'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; path = [string]$_.ExecutablePath; started = $_.CreationDate.ToUniversalTime().ToString('o'); command = [string]$_.CommandLine } } | ConvertTo-Json -Compress";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) throw new Error(`could not list coral-tray.exe processes: ${r.error ? r.error.message : (r.stderr || '').trim() || 'exit ' + r.status}`);
  const out = (r.stdout || '').trim();
  if (!out) return [];
  const v = JSON.parse(out);
  return Array.isArray(v) ? v : [v];
}
