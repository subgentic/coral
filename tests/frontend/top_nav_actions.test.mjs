// #18093: the Queue tab did nothing when clicked, because the m-switch-nav-tab handler (app_actions.js) opened only the tab names a hand-kept list named, and Queue was not on it (v2.0.69 trial).
// The handler now opens any argument that names a top-bar tab (the element nav-tab-<arg>), so a new tab cannot be left off a list. This pins both halves: no list in the handler, and every tab button's id is nav-tab-<its arg>.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const actions = fs.readFileSync(path.join(root, 'static', 'app_actions.js'), 'utf8');
const line = actions.split('\n').find(l => l.includes("'m-switch-nav-tab':"));
assert.ok(line, 'app_actions.js has the m-switch-nav-tab handler');
assert.ok(!/\[\s*"[a-z-]+"\s*,/.test(line), 'the handler keeps no list of tab names (a tab left off it does nothing when clicked): ' + line.trim().slice(0, 200));
assert.match(line, /getElementById\('nav-tab-' \+ el\.dataset\.arg\)/, 'the handler opens a tab that names a top-bar button');
const buttons = [...html.matchAll(/<button[^>]*class="[^"]*top-nav-tab[^"]*"[^>]*>/g)].map(m => m[0]).filter(b => /data-on-click="m-switch-nav-tab"/.test(b));
assert.ok(buttons.length >= 8, 'the top bar buttons were found: ' + buttons.length);
for (const b of buttons) {
    const arg = /data-arg="([^"]+)"/.exec(b)[1], id = /\sid="([^"]+)"/.exec(b)[1];
    assert.equal(id, 'nav-tab-' + arg, `the tab "${arg}" has the id ${id}: the click handler finds a tab by nav-tab-<arg>`);
}
console.log('top_nav_actions: ok (' + buttons.length + ' tabs)');
