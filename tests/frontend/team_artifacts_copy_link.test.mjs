// Artifacts panel: every row with a link has a "Copy link" button that copies
// the absolute URL, and the header instructions no longer mention tasks.
// Run: node team_artifacts_copy_link.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, importUi, STATIC } from './helpers/jsdom_env.mjs';

installDom();
const digest = 'a'.repeat(64);
const artifacts = [
    { id: digest, name: 'report.md', uri: `coral://artifacts/${digest}`, media_type: 'text/markdown', source: 'upload' },
    { id: 'ext', name: 'Design doc', uri: 'https://docs.example/d/1', task_id: 7 },
    { id: 'gone', name: 'old.txt', uri: `coral://artifacts/${'b'.repeat(64)}`, available: false },
];
globalThis.fetch = window.fetch = async (url) => {
    assert.match(String(url), /\/api\/session-artifacts\?/);
    return { ok: true, status: 200, json: async () => ({ artifacts, session_id: 's1', has_more: false }) };
};
const copied = [];

Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => { copied.push(text); } },
});

const { state } = await importUi('state');
state.currentSession = { type: 'live', session_id: 's1', name: 'dev' }; // standalone: no team
const { initFilesSourcePicker, selectFilesSource } = await importUi('team_artifacts');
initFilesSourcePicker(() => {});
selectFilesSource('artifacts');
const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };
const view = document.getElementById('agentic-panel-artifacts-view');
await until(() => view.querySelectorAll('tbody tr').length === 3);
const rows = [...view.querySelectorAll('tbody tr')];
assert.equal(rows.length, 3);
const pane = document.getElementById('agentic-detail-pane');
// a row opens its sheet over the panel; Copy link is one of the sheet's actions
const copyLink = () => [...pane.querySelectorAll('.detail-foot .btn')].find(b => b.textContent === 'Copy link');
const openRow = async (i) => { rows[i].querySelector('.team-row-btn').click(); await until(() => !pane.hidden); return copyLink(); };

const first = await openRow(0);
assert.ok(first, 'a stored artifact has a Copy link action');
first.click();
await until(() => copied.length === 1);
assert.deepEqual(copied, [`coral://artifacts/${digest}`], 'a managed artifact copies its coral:// reference');
const second = await openRow(1);
assert.ok(second, 'an external link has a Copy link action');
second.click();
await until(() => copied.length === 2);
assert.equal(copied[1], 'https://docs.example/d/1', 'external links copy their own URL');
assert.equal(await openRow(2), undefined, 'a missing artifact has nothing to copy');

// The header copy button pastes instructions with no task or manifest step.
copied.length = 0;
view.querySelector('.team-artifacts-help').click();
await until(() => copied.length === 1);
assert.equal(copied.length, 1);
assert.match(copied[0], /coral-agent artifact upload <file>/);
assert.match(copied[0], /appears in the Artifacts tab right away/);
assert.doesNotMatch(copied[0], /task|manifest/i);
// The source carries the same text the button copied (guards against a second copy of it).
assert.ok(fs.readFileSync(STATIC + 'team_artifacts_page.js', 'utf8').includes('It appears in the Artifacts tab right away.'));

console.log('team_artifacts_copy_link: ok');
process.exit(0);
