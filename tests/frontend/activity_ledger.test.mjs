// The Activity ledger as the approved mock draws it (#22100): a file's Versions popover, the one line of what was done, days, links and the phone menu (#19816). jsdom, no browser: node activity_ledger.test.mjs
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const dom = new JSDOM('<!doctype html><body><script id="coral-boot" type="application/json">{"mode":"local"}</script></body>', { url: 'http://127.0.0.1:8420/' });
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'sessionStorage', 'getComputedStyle', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'AbortController']) {
    Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
globalThis.matchMedia = () => ({ matches: false }); // jsdom has none: the table's head asks whether the screen is a touch one (#17869); this is a mouse's
const Ledger = await import(pathToFileURL(path.join(dir, 'activity_ledger.js')).href);
const hex = n => String(n).repeat(64).slice(0, 64);
const file = (id, n, at, action = 'approve') => ({ id, at, action, item_kind: 'file', item_id: hex(n), version: hex(n), title: 'plan.md', team: 'team' });
const x = { label: 'Activity', parts: r => ({ did: r.action === 'approve' ? 'Approved' : 'Changes', on: r.title, detail: r.note || '', about: '' }), opens: () => true, openRow: r => opened.push(r), openLabel: r => r.title, teamWords: () => 'team', fromWords: r => r.asker || '', doneFrom: () => 'this computer', keyOf: r => String(r.id) };
const opened = [], goals = [], tasks = [];
x.openGoal = r => goals.push(r.goal_id); x.openTask = r => tasks.push(r.task_id);
const now = Date.UTC(2026, 10, 19, 12);
const rows = [file(3, 3, new Date(now - 3e3).toISOString()), file(2, 2, new Date(now - 6e4).toISOString(), 'changes'), { id: 4, at: new Date(now - 1e3).toISOString(), action: 'approve', item_kind: 'file', item_id: hex(9), version: hex(9), title: 'other.md', team: 'team' }];
const ul = Ledger.ledger(rows, x, { now });
const row3 = ul.querySelector('.al-row[data-key="3"]');
const vers = row3.querySelector('details.al-versions');
assert.ok(vers, 'a file with two versions in the list has a Versions button');
assert.match(vers.querySelector('summary').textContent, /^Versions \(2\)$/);
assert.equal(ul.querySelector('.al-row[data-key="4"] details.al-versions'), null, 'a file with one version has none');
const names = [...vers.querySelectorAll('.al-pop-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
assert.match(names[0], /^v2Latest/, 'newest first'); assert.match(names[1], /^v1/);
vers.querySelectorAll('.al-pop-row')[1].querySelector('button').click();
assert.equal(opened.at(-1).id, 2, 'Open on v1 opens that version\'s record');
assert.ok(row3.querySelector('.al-pop').getAttribute('aria-label') === 'Document versions');

// the server's list (the upload records) wins: version numbers, the reviewed one and the newest, and a version no record in the list names still opens
const sv = (id, n, at) => ({ digest: hex(n), n, at });
const srv = { ...file(30, 1, new Date(now - 7e3).toISOString()), file_n: 1, file_latest_n: 3, ask: 'Approve the plan?', file_versions: [sv(0, 1, new Date(now - 9e4).toISOString()), sv(0, 2, new Date(now - 8e4).toISOString()), sv(0, 3, new Date(now - 7e4).toISOString())] };
const ul2 = Ledger.ledger([srv], x, { now });
const r2 = ul2.querySelector('.al-row');
assert.equal(r2.querySelector('.al-ver').textContent, 'version 1 of 3', 'the version the row acted on and the newest, in grey, once');
assert.equal(r2.querySelector('.al-vchip, .al-vnewer'), null, 'no version pills');
assert.equal(r2.querySelector('.al-ask'), null, 'no line for the ask: the mock draws none'); assert.equal(r2.querySelector('.al-title').title, 'Approve the plan?', 'the question the file was sent with is the name\'s tip');
assert.equal(r2.querySelector('.al-v').textContent, '\u2713 Approved', 'what you did, as a word with a mark');
assert.equal(r2.querySelector('summary').textContent, 'Versions (3)');
const pr = [...r2.querySelectorAll('.al-pop-row')];
assert.deepEqual(pr.map(e => e.querySelector('.al-pop-name').textContent), ['v3', 'v2', 'v1'], 'every version the records name');
pr[1].querySelector('button').click();
assert.equal(opened.at(-1).version, hex(2), 'a version with no record of its own opens by its digest');
const latestRow = { ...file(31, 3, new Date(now).toISOString()), file_n: 3, file_latest_n: 3 };
const ul3 = Ledger.ledger([latestRow], x, { now });
assert.equal(ul3.querySelector('.al-ver').textContent, 'version 3', 'the newest version has no "of N"');
assert.equal(ul3.querySelector('.al-open'), null, 'no Open button: the title opens it');

// the kind mark is a quiet drawing, one per kind; no tile
const tiles = Ledger.ledger([{ ...file(40, 4, new Date(now).toISOString()), title: 'promo-cut-1.html' }, { ...file(41, 5, new Date(now).toISOString()), title: 'design.md' }, { ...file(42, 6, new Date(now).toISOString()), title: 'shot.png' }], x, { now });
assert.deepEqual([...tiles.querySelectorAll('.al-lead svg')].map(e => e.getAttribute('aria-label')), ['Web page', 'Text document', 'Image']);
assert.equal(tiles.querySelector('.al-tile'), null);
// days: a heading with its count above its own list
assert.equal(ul.querySelectorAll('.al-date-head').length, 1);
assert.equal(ul.querySelector('.al-date-head .al-day-count').textContent, '3');
assert.match(ul.querySelector('.al-row .al-when').textContent, /\d:\d\d/, 'the time at the right is a clock time');
// an answered question says what you answered inline, to whom; goal, task and team are links
const base = { id: 7, at: new Date(now).toISOString(), action: 'answered', item_kind: 'question', item_id: '5', title: 'Did it arrive?', note: 'from Orchestrator · Yes, it did', asker: 'Orchestrator', team: 'team', goal_id: 41, goal_title: 'Checkout redesign', task_id: 413, task_title: 'One-page layout' };
const q = Ledger.ledger([base], { ...x, parts: r => ({ did: 'Answered', on: r.title, detail: r.note, about: '' }), fromWords: r => `from ${r.asker}` }, { now });
assert.equal(q.querySelector('.al-sub .al-seg').textContent, 'Answered \u201cYes, it did\u201d to Orchestrator\u00a0\u00b7', 'the dot after a segment is held to its last word (#22100 round 2: no line starts with a dot)');
assert.equal(q.querySelector('details.al-qa'), null, 'no Q&A preview on the row');
assert.equal(q.querySelector('.al-sub .al-who').textContent, 'Orchestrator', 'the agent answered is its own (bold) link, as the mock draws it');
const links = [...q.querySelectorAll('.al-sub .al-link:not(.al-who)')];
assert.deepEqual(links.map(b => b.textContent), ['#41 Checkout redesign', 'task #413 One-page layout']);
assert.ok(links[0].querySelector('svg.al-gflag'), 'the goal has its flag');
links[0].click(); links[1].click();
assert.deepEqual([goals.at(-1), tasks.at(-1)], [41, 413]);
// grouped under its task, the row does not say the goal and task again
const grouped = Ledger.ledger([base], { ...x, hideGoal: true, hideTask: true, parts: r => ({ did: 'Answered', on: r.title, detail: r.note, about: '' }) }, { now, groupFor: () => ({ key: 'g', label: 'Goal', open: true }) });
assert.equal(grouped.querySelector('.al-sub .al-link:not(.al-who)'), null); // no goal or task link; the agent answered stays named
// your words on a file: a plain box that says whose they are; a permission's command in its own line
const r3 = Ledger.ledger([{ ...file(51, 7, new Date(now).toISOString(), 'changes'), note: 'Fix the title' }, { id: 60, at: new Date(now).toISOString(), action: 'prompt_allow', item_kind: 'agent', item_id: 'a', title: 'a', note: 'Yes', command: 'npm install x', team: 'team' }], { ...x, parts: r => ({ did: r.action === 'changes' ? 'Asked for changes' : 'Allowed', on: r.title, detail: r.note, about: '' }) }, { now });
const [ra, rb] = [...r3.querySelectorAll('.al-row')];
assert.equal(ra.querySelector('.al-ynote').textContent, 'Your note: Fix the title');
assert.equal(ra.querySelector('.al-v').textContent, '\u21a9 Asked for changes');
assert.equal(rb.querySelector('.al-cmd').textContent, 'npm install x');
assert.equal(rb.querySelector('.al-title').textContent, 'a asked for permission'); // a recorded command: the title says so, the box holds it
assert.ok(!rb.querySelector('.al-sub').textContent.includes('(Yes)'), 'a bare Yes is not repeated after Allowed');
// the phone's one menu holds what the hover buttons hold
const dots = ul.querySelector('.al-row[data-key="3"] details.al-dots');
assert.ok(dots && dots.querySelector('summary').getAttribute('aria-label').startsWith('Actions for'), 'a phone menu on a row with actions');
assert.deepEqual([...dots.querySelectorAll('.al-menu-item')].map(b => b.textContent), ['Open version 2', 'Open version 1']);
console.log('ok activity_ledger');
