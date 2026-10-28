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
    if (String(url).endsWith('/kept')) return {ok:true,json:async()=>({kept:[]})};
    assert.match(String(url), /\/api\/(?:session-artifacts\?|board\/test\/artifacts\?)/);
    return { ok: true, status: 200, json: async () => ({ project: 'test', artifacts, session_id: 's1', has_more: false }) };
};
const copied = [];

Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => { copied.push(text); } },
});

const { state } = await importUi('state');
state.currentSession = { type: 'live', session_id: 's1', name: 'dev' }; // standalone: no team
const previews = [];
const { registerBundled } = await importUi('import_once');
registerBundled({'preview_pane.js': {openArtifactTab: (uri, options) => previews.push({uri, options}), setPreviewSession: () => {}}});
const { initFilesSourcePicker, selectFilesSource } = await importUi('team_artifacts');
initFilesSourcePicker(() => {});
selectFilesSource('artifacts');
const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };
const view = document.getElementById('agentic-panel-artifacts-view');
await until(() => view.querySelectorAll('tbody tr').length === 3);
let rows = [...view.querySelectorAll('tbody tr')];
assert.equal(rows.length, 3, view.textContent);
const pane = document.getElementById('agentic-detail-pane');
rows[0].querySelector('.dt-primary').click();
await until(() => previews.length === 1);
assert.equal(previews[0].uri, `coral://artifacts/${digest}`);
assert.equal(pane.hidden, true, 'the dock opens preview without covering the list');
rows[1].querySelector('.dt-primary').click();
await until(() => previews.length === 2);
assert.equal(previews[1].options.externalURL, 'https://docs.example/d/1');
assert.equal(pane.hidden, true, 'a second click needs no close step');
// Team-wide artifacts retain their detail sheet and Copy link actions.
const { showArtifacts } = await importUi('team_artifacts_page');
await showArtifacts(view, 'test', {detailHost:pane});
rows = [...view.querySelectorAll('tbody tr')];
const copyLink = () => [...pane.querySelectorAll('.detail-foot .btn')].find(b => b.textContent === 'Copy link');
const openRow = async (i) => { rows[i].querySelector('.dt-primary').click(); await until(() => !pane.hidden); return copyLink(); };

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

// The toolbar's More menu has Copy publishing instructions: it pastes instructions with no task or manifest step.
copied.length = 0;
view.querySelector('.list-bar-more-btn').click();
await until(() => !view.querySelector('.list-bar-more-menu').hidden);
const item = [...view.querySelectorAll('.list-bar-more-menu [role="menuitem"]')].find(b => b.textContent === 'Copy publishing instructions');
assert.ok(item, 'the menu has Copy publishing instructions');
item.click();
await until(() => copied.length === 1);
assert.equal(copied.length, 1);
assert.match(copied[0], /coral-agent artifact upload <file>/);
assert.match(copied[0], /appears in the Artifacts tab right away/);
assert.doesNotMatch(copied[0], /task|manifest/i);
// The source carries the same text the button copied (guards against a second copy of it).
assert.ok(fs.readFileSync(STATIC + 'team_artifacts_page.js', 'utf8').includes('It appears in the Artifacts tab right away.'));

console.log('team_artifacts_copy_link: ok');
process.exit(0);
