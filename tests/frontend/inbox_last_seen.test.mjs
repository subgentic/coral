// Last-known Needs you rows of an offline computer (#15380, C): kept in memory, listed read-only as text, never counted, dropped on sign-out and when the computer is removed. jsdom: node inbox_last_seen.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:8420/' });
for (const k of ['window', 'document', 'localStorage', 'sessionStorage', 'Event', 'CustomEvent']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
const LS = await import(pathToFileURL(path.join(dir, 'inbox_last_seen.js')).href);
const sessionServer = r => r.server || 'local';
const lineOf = r => r.text;
const online = [{ id: 'lab', label: 'Lab', status: 'online' }, { id: 'attic', label: 'Att\u202eic', status: 'online' }];
const rows = [{ server: 'lab', text: 'wants to run\u0007 <img src=x onerror=alert(1)>' }, { server: 'lab', text: 'second', proposal: {} }, { server: 'attic', text: 'q', operatorAsk: {} }, { server: 'local', text: 'mine' }, { server: 'lab', welcome: true, text: 'welcome' }];
const T0 = Date.UTC(2026, 10, 10, 12, 4);
LS.remember(online, rows, sessionServer, lineOf, T0);
assert.deepEqual(LS.offline(online), [], 'an online computer is not listed as offline');
const down = [{ ...online[0], status: 'offline' }, online[1]];
const off = LS.offline(down);
assert.equal(off.length, 1);
assert.equal(off[0].rows.length, 2, 'only that computer\'s rows; the local one and the welcome item are not kept for it');
assert.match(LS.words(off[0]), /^2 on Lab \(offline, last seen \d\d:\d\d\)$/);
const node = LS.node(down);
assert.equal(node.querySelectorAll('img, a, button, input').length, 0, 'text only: no markup, no action');
assert.ok(!/\u0007/.test(node.textContent));
assert.ok(node.textContent.includes('<img src=x onerror=alert(1)>'), 'shown as text, not parsed');
// a computer that is still offline keeps what it last showed even as remember() runs again
LS.remember(down, rows.slice(2), sessionServer, lineOf, T0 + 60000);
assert.equal(LS.offline(down)[0].rows.length, 2);
assert.equal(LS.offline(down)[0].at, T0, 'the time is when it was last online');
assert.equal(LS.signature(down).length, 1);
// removed: forgotten
LS.remember([online[1]], rows, sessionServer, lineOf, T0);
assert.deepEqual(LS.offline([{ id: 'lab', label: 'Lab', status: 'offline' }]), []);
// sign-out forgets everything
LS.remember(online, rows, sessionServer, lineOf, T0);
document.dispatchEvent(new CustomEvent('coral:signed-out'));
assert.deepEqual(LS.offline([{ ...online[0], status: 'offline' }, { ...online[1], status: 'offline' }]), []);
// never stored
assert.equal(dom.window.localStorage.length + dom.window.sessionStorage.length, 0, 'nothing is written to storage');
const src = fs.readFileSync(path.join(dir, 'inbox_last_seen.js'), 'utf8');
assert.ok(!/localStorage|sessionStorage|browserLocal|indexedDB|document\.cookie|innerHTML/.test(src), 'the module has no storage and no markup path');
// the sidebar hands the page the foot and the count never sees it
const side = fs.readFileSync(path.join(dir, 'inbox_sidebar.js'), 'utf8');
assert.ok(/lastSeenLine\(\)\]\.filter\(Boolean\)/.test(side), 'the foot carries the block');
console.log('inbox last seen ok');
