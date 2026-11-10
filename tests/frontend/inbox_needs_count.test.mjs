// One number for Needs you (#15380 D): the tab's badge, the sidebar's count and the page header all read needsCount(), with a computer online and one offline. jsdom: node inbox_needs_count.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const dom = new JSDOM('<!doctype html><body><script id="coral-boot" type="application/json">{"mode":"local"}</script><a id="nav-tab-hub-inbox"></a><span id="nav-tab-hub-inbox-badge" hidden></span></body>', { url: 'http://127.0.0.1:8420/' });
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'sessionStorage', 'getComputedStyle', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'AbortController']) {
    Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
dom.window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const { state } = await import(pathToFileURL(path.join(dir, 'state.js')).href);
const T = await import(pathToFileURL(path.join(dir, 'inbox_tab.js')).href);
const waiting = (id, server) => ({ session_id: id, display_name: id, server, waiting_for_input: true, waiting_kind: 'permission', waiting_since: '2026-11-10T12:00:00Z', status: 'waiting' });
state.hub = true;
state.servers = [{ id: 'on1', label: 'Lab', status: 'online' }, { id: 'off1', label: 'Attic', status: 'offline' }];
state.liveSessions = [waiting('a1', 'local'), waiting('b1', 'on1')];
T.updateInboxTab();
const badge = () => document.getElementById('nav-tab-hub-inbox-badge');
assert.equal(T.needsCount(0), T.waitingCount(), 'with nothing else the number is the waiting agents');
assert.equal(badge().textContent, String(T.needsCount()) === '0' ? '' : String(T.needsCount()), 'the badge is the one number');
// the page and the sidebar call the same function
const side = fs.readFileSync(path.join(dir, 'inbox_sidebar.js'), 'utf8');
assert.ok(/key === 'needs' \? needsCount\(/.test(side), "the sidebar's Needs you count is needsCount()");
console.log('inbox needs count ok');
