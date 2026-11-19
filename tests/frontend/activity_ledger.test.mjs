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
assert.match(names[0], /^v1/); assert.match(names[1], /^v2Latest \(reviewed\)/);
vers.querySelector('.al-pop-row button').click();
assert.equal(opened.at(-1).id, 2, 'Open on v1 opens that version\'s record');
assert.ok(row3.querySelector('.al-pop').getAttribute('aria-label') === 'Document versions');
const q = Ledger.ledger([{ id: 7, at: new Date(now).toISOString(), action: 'answered', item_kind: 'question', item_id: '5', title: 'Did it arrive?', note: 'from Orchestrator · Yes, it did', asker: 'Orchestrator', team: 'team' }], { ...x, parts: r => ({ did: 'Answered', on: r.title, detail: r.note, about: '' }) }, { now });
const qa = q.querySelector('details.al-qa');
assert.ok(qa, 'an answered question has a Q&A preview');
assert.match(qa.querySelector('summary').textContent, /Preview Q&A \(2 messages\)/);
assert.deepEqual([...qa.querySelectorAll('.al-qa-who')].map(e => e.textContent), ['Orchestrator', 'You']);
assert.equal(qa.querySelectorAll('.al-qa-text')[1].textContent, 'Yes, it did');
assert.equal(ul.querySelector('details.al-qa'), null, 'a file row has no Q&A preview');
console.log('ok activity_ledger');
