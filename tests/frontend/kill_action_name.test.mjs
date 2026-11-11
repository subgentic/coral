// One name for ending an agent (#15371, user feedback: 'Kill session' in some places, 'Remove agent' in others). The row menu's item and its confirm are Kill Session / Kill session
// everywhere (the same words as the docs, Kill All and Kill Team); 'Remove Agent' is not a label of any button. This reads every module: each agent-kill menu item says Kill Session,
// and no module draws a button or menu item named Remove Agent.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const bad = [];
let kills = 0;
for (const f of fs.readdirSync(STATIC).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(STATIC, f), 'utf8');
    // a module may keep a menu's markup in constants (session_rows.js): resolve ${_mkN} before reading the label
    const consts = Object.fromEntries([...src.matchAll(/const (_mk\d+) = ("(?:[^"\\]|\\.)*");/g)].map(m => [m[1], JSON.parse(m[2])]));
    for (const m of src.matchAll(/data-on-click="agent-kill"[^>]*>((?:(?!<\/button>|`)[\s\S])*)/g)) {
        kills++;
        let body = m[1].replace(/\$\{(_mk\d+)\}/g, (_, k) => consts[k] || '');
        const label = body.replace(/<[^>]*>/g, ' ').replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
        if (!/(^|\s)Kill Session$/.test(label)) bad.push(`${f}: an agent-kill menu item is labelled "${label.slice(-40)}", not Kill Session`);
    }
    if (/>\s*Remove Agent\s*</.test(src) || /\\n\s*Remove Agent\\n/.test(src)) bad.push(`${f}: a button is named Remove Agent`);
}
assert.ok(kills >= 2, `the agent-kill menu items were found (${kills})`);
assert.deepEqual(bad, []);
console.log(`kill_action_name: ok (${kills} menu items)`);
