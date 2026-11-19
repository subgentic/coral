// The Activity ledger: a file's Versions popover and an answered question's Q&A preview (#19816). jsdom, no browser: node activity_ledger.test.mjs
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
const file = (id, n, at, action = 'approved') => ({ id, at, action, item_kind: 'file', item_id: hex(n), version: hex(n), title: 'plan.md', team: 'team' });
const x = { label: 'Activity', parts: r => ({ did: r.action === 'approved' ? 'Approved' : 'Changes', on: r.title, detail: r.note || '', about: '' }), opens: () => true, openRow: r => opened.push(r), openLabel: r => r.title, teamWords: () => 'team', fromWords: r => r.asker || '', doneFrom: () => 'this computer', keyOf: r => String(r.id) };
const opened = [];
const now = Date.UTC(2026, 10, 19, 12);
const rows = [file(3, 3, new Date(now - 3e3).toISOString()), file(2, 2, new Date(now - 6e4).toISOString(), 'changes'), { id: 4, at: new Date(now - 1e3).toISOString(), action: 'approved', item_kind: 'file', item_id: hex(9), version: hex(9), title: 'other.md', team: 'team' }];
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
assert.equal(r2.querySelector('.al-vchip').textContent, 'v1', 'the version the row acted on');
assert.equal(r2.querySelector('.al-vnewer').textContent, 'v1 reviewed \u00b7 v3 newer');
assert.equal(r2.querySelector('.al-ask').textContent, 'Approve the plan?', 'the question the file was sent with');
assert.equal(r2.querySelector('.al-open').textContent, 'Open v1', 'the reviewed version, not the newest');
assert.equal(r2.querySelector('summary').textContent, 'Versions (3)');
const pr = [...r2.querySelectorAll('.al-pop-row')];
assert.deepEqual(pr.map(e => e.querySelector('.al-pop-name').textContent), ['v3', 'v2', 'v1'], 'every version the records name');
pr[1].querySelector('button').click();
assert.equal(opened.at(-1).version, hex(2), 'a version with no record of its own opens by its digest');
const latestRow = { ...file(31, 3, new Date(now).toISOString()), file_n: 3, file_latest_n: 3 };
const ul3 = Ledger.ledger([latestRow], x, { now });
assert.equal(ul3.querySelector('.al-vnewer'), null, 'the newest version has no "newer" note');
assert.equal(ul3.querySelector('.al-open').textContent, 'Open file');

// a file's tile says its type; a markdown file has a text glyph, a video an icon
const tiles = Ledger.ledger([{ ...file(40, 4, new Date(now).toISOString()), title: 'promo-cut-1.mp4' }, { ...file(41, 5, new Date(now).toISOString()), title: 'design.md' }], x, { now });
const [t1, t2] = [...tiles.querySelectorAll('.al-tile')];
assert.ok(t1.classList.contains('al-fk-video')); assert.equal(t1.textContent, 'play_arrow');
assert.ok(t2.classList.contains('al-fk-markdown')); assert.equal(t2.textContent, 'M\u2193');
const q = Ledger.ledger([{ id: 7, at: new Date(now).toISOString(), action: 'answered', item_kind: 'question', item_id: '5', title: 'Did it arrive?', note: 'from Orchestrator · Yes, it did', asker: 'Orchestrator', team: 'team' }], { ...x, parts: r => ({ did: 'Answered', on: r.title, detail: r.note, about: '' }) }, { now });
const qa = q.querySelector('details.al-qa');
assert.ok(qa, 'an answered question has a Q&A preview');
assert.match(qa.querySelector('summary').textContent, /Preview Q&A \(2 messages\)/);
assert.deepEqual([...qa.querySelectorAll('.al-qa-who')].map(e => e.textContent), ['Orchestrator', 'You']);
assert.equal(qa.querySelectorAll('.al-qa-text')[1].textContent, 'Yes, it did');
assert.equal(ul.querySelector('details.al-qa'), null, 'a file row has no Q&A preview');
// the preview reads the real thread when opened: the question, the answer and the next reply
const q3 = Ledger.ledger([{ id: 8, at: new Date(now).toISOString(), action: 'answered', item_kind: 'question', item_id: '5', title: 'Did it arrive?', note: 'from Orchestrator · Yes, it did', asker: 'Orchestrator', team: 'team' }], { ...x, parts: r => ({ did: 'Answered', on: r.title, detail: r.note, about: '' }), threadFor: async () => [{ who: 'Orchestrator', text: 'Did it arrive?' }, { who: 'You', text: 'Yes, it did' }, { who: 'Orchestrator', text: 'Thanks, closing it' }, { who: 'You', text: 'ok' }] }, { now });
const qa3 = q3.querySelector('details.al-qa'); qa3.open = true; qa3.dispatchEvent(new dom.window.Event('toggle'));
await new Promise(r => setTimeout(r, 10));
assert.equal(qa3.querySelectorAll('.al-qa-msg').length, 3, 'the preview shows the first three messages');
assert.match(qa3.querySelector('summary').textContent, /Preview Q&A \(3 of 4 messages\)/);
assert.equal(qa3.querySelectorAll('.al-qa-text')[2].textContent, 'Thanks, closing it');
console.log('ok activity_ledger');
