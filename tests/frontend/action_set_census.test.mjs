// The operator's one action set (#11554): the same action looks the same on every screen. This census pins the parts already made one: a failed read offers "Retry" (never "Try again" on a button), and a
// delete control is the `delete` icon, never a × (a × means close). Failing-first: both fail on the files before #11554.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const fe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend');
const read = rel => fs.readFileSync(path.join(fe, rel), 'utf8');
const files = fs.readdirSync(path.join(fe, 'static')).filter(f => f.endsWith('.js')).map(f => `static/${f}`).concat(['templates/index.html']);
const again = [];
for (const rel of files) {
    const t = read(rel);
    for (const m of t.matchAll(/(btn\(|el\('button'|textContent = |<button[^>]*>)[^\n]{0,80}?['">]Try again['"<]/g)) {
        if (rel === 'static/inbox_item_page.js') continue; // the Inbox's own buttons are #11552's
        again.push(`${rel}: ${m[0].slice(0, 100)}`);
    }
}
assert.deepEqual(again, [], `a button that retries says Retry:\n${again.join('\n')}`);
for (const [rel, cls] of [['static/board_window.js', 'mb-delete-msg-btn']]) {
    const t = read(rel), at = t.indexOf(cls), btn = t.slice(at, t.indexOf('</button>', at));
    assert.ok(/material-icons[^>]*>delete</.test(btn) && !/&times;|×/.test(btn), `${rel}: ${cls} is the delete icon, not a ×: ${btn.slice(-120)}`);
}
const css = read('static/css/components.css');
assert.ok(/#mb-pause-btn\.mb-action-btn\.mb-action-danger\s*\{[^}]*--warning-text/.test(css), 'a paused board\'s Resume is the warning colour, not the delete red');
console.log('action_set_census: ok (Retry on buttons, delete is an icon, Resume is not red)');
