// Pure display lease contract: controlled clock/timers, no browser or sleep.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const dialog = fs.readFileSync(new URL('../../coral-go/pkg/frontend/static/at_dialog.js', import.meta.url), 'utf8'); // the module has no imports of its own except at_dialog.js (#11430): joined here, since the file is loaded as one data URL
const source = dialog + fs.readFileSync(new URL('../../coral-go/pkg/frontend/static/display_activity_hint.js', import.meta.url), 'utf8').replace(/^import \{ dialogDue \} from '\.\/at_dialog\.js';\n/, '');
const { hasWorkingDisplayHint, needsInputAttention, trackDisplayHint } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
let now = Date.parse('2026-10-26T07:00:20Z');
const row = { session_id: 'fixture', agent_type: 'codex', waiting_for_input: true, waiting_kind: 'permission', waiting_since: '2026-10-26T07:00:00Z', display_activity_hint: 'working', display_activity_hint_at: '2026-10-26T07:00:19Z' };
assert.equal(hasWorkingDisplayHint(row, now), true);
const saved = structuredClone(row);
for (const patch of [{ agent_type: 'claude' }, { waiting_kind: 'question' }, { waiting_kind: 'plan' }, { waiting_kind: 'login' }, { waiting_kind: 'startup' }, { waiting_kind: 'elicitation' }, { waiting_for_input: false }, { waiting_since: null }, { waiting_since: '2026-10-26T07:00:18Z' }, { display_activity_hint: null }, { display_activity_hint: 'other' }, { display_activity_hint_at: 'bad' }, { display_activity_hint_at: '2026-10-26T07:00:21Z' }, { display_activity_hint_at: '2026-10-26T07:00:10Z' }, { sleeping: true }, { archived: true }, { needs_login: true }, { stuck: true }, { not_started: true }]) {
    assert.equal(hasWorkingDisplayHint({ ...row, ...patch }, now), false, JSON.stringify(patch));
}
assert.deepEqual(row, saved, 'display evidence never mutates authoritative input');
const realNow = Date.now, realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
let callback, scheduled = 0; const events = [];
try {
    Date.now = () => now;
    globalThis.document = { dispatchEvent: e => events.push(e.type) };
    globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
    globalThis.setTimeout = fn => { callback = fn; scheduled++; return scheduled; };
    globalThis.clearTimeout = () => {};
    assert.equal(needsInputAttention(row), false);
    trackDisplayHint(row); assert.equal(scheduled, 1, 'same lease schedules once');
    now += 10_000; callback();
    assert.deepEqual(events, ['coral:display-hint-expired']);
    assert.equal(needsInputAttention(row), true, 'a stalled socket cannot keep attention hidden');
    assert.equal(needsInputAttention({ ...row, waiting_kind: 'question' }), true);
    assert.deepEqual(row, saved);
} finally {
    Date.now = realNow; globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
    delete globalThis.document; delete globalThis.CustomEvent;
}
console.log('display activity hint contract: PASS');
