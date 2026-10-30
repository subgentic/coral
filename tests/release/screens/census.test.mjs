// The census of the release screenshots (#11216): a route, a nav tab, a Settings section or a dialog the dashboard has and pages.mjs does not name fails here, so a new page cannot be skipped.
// The sources are the dashboard's own: routes.js (the parser and its lists), app_routes.js (the views with a handler), templates/index.html (the nav tabs) and includes/modals.html (the dialogs
// and the Settings sections).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGES, ALIASES, NOT_PHOTOGRAPHED, MODAL_PAGE, NAV_TAB_PAGE, WIDTHS } from './pages.mjs';
import { OPENERS } from './openers.mjs';
import { STUBS } from './stubs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '../../../coral-go/pkg/frontend');
const read = rel => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');
const routes = await import(pathToFileURL(path.join(FRONTEND, 'static/routes.js')).href);
const PLACEHOLDERS = new Set(['team', 'agentWorking', 'agentWaiting', 'agentIdle', 'agentAsleep', 'goal', 'task', 'workflow', 'run', 'job', 'chat']);
const ids = new Set(PAGES.map(p => p.id));
const samePath = p => p.path.replace(/\{(\w+)\}/g, (_, k) => (k === 'team' ? 'checkout-redesign' : /^agent/.test(k) ? '0a1b2c3d-0000-4000-8000-000000000001' : k === 'chat' ? 'chat-1' : '1'));
const parsed = p => { const [pathname, search = ''] = samePath(p).split('?'); return routes.parse(pathname, search ? '?' + search : ''); };

test('the list is well formed: unique ids, one way to the page, known worlds, placeholders and openers', () => {
    assert.equal(ids.size, PAGES.length, 'duplicate page id');
    for (const p of PAGES) {
        assert.match(p.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, p.id);
        assert.ok(['seeded', 'fresh'].includes(p.world), `${p.id}: world`);
        assert.ok(Boolean(p.path) !== Boolean(p.open), `${p.id}: exactly one of path and open`);
        for (const m of (p.path || '').matchAll(/\{(\w+)\}/g)) assert.ok(PLACEHOLDERS.has(m[1]), `${p.id}: unknown placeholder {${m[1]}}`);
        if (p.open) assert.equal(typeof OPENERS[p.open], 'function', `${p.id}: no opener named ${p.open}`);
        if (p.stub) assert.ok(STUBS[p.stub], `${p.id}: no stub named ${p.stub}`);
    }
});

test('every page address is a route the router parses', () => {
    for (const p of PAGES.filter(x => x.path)) assert.ok(parsed(p), `${p.id}: ${p.path} is not a route the router reads`);
});

test('three widths: full, middle, phone', () => {
    assert.deepEqual(WIDTHS.map(w => [w.name, w.width]), [['1440', 1440], ['900', 900], ['390', 390]]);
    assert.equal(WIDTHS.filter(w => w.mobile).length, 1);
});

test('every view the router has a handler for has a page or an alias', () => {
    const src = read('static/app_routes.js');
    const views = new Set([...src.matchAll(/\b(?:route|onRoute)\('([a-z]+(?:-[a-z]+)*)'/g)].map(m => m[1]));
    const sub = src.match(/for \(const sub of \[([^\]]+)\]\) route\('inbox-' \+ sub/);
    assert.ok(sub, 'the Inbox family loop moved: update the census');
    for (const s of sub[1].matchAll(/'([a-z]+)'/g)) views.add('inbox-' + s[1]);
    assert.ok(views.size >= 12, `read only ${[...views]}`);
    const have = new Set(PAGES.filter(p => p.path).map(parsed).filter(Boolean).map(r => r.view));
    for (const v of views) assert.ok(have.has(v) || ALIASES[v], `the "${v}" view has no page in pages.mjs (and no alias)`);
    for (const a of Object.keys(ALIASES)) assert.ok(views.has(a), `ALIASES names "${a}", which is not a view`);
});

test('every team tab, agent tab, Analytics page and Automations folder has a page', () => {
    const urls = PAGES.filter(p => p.path).map(samePath);
    const has = re => urls.some(u => re.test(u));
    for (const t of routes.TEAM_TABS) {
        const word = t === 'messages' ? 'board' : t; // the Board tab's path word
        assert.ok(t === 'goals' ? has(/^\/team\/[^/]+$/) : has(new RegExp(`^/team/[^/]+/${word}$`)), `team tab ${t}`);
    }
    for (const t of routes.AGENT_SUBTABS) assert.ok(has(new RegExp(`^/agents/[^/]+/${t}$`)), `agent tab ${t}`);
    for (const t of routes.ANALYTICS_PAGES) assert.ok(has(new RegExp(`^/analytics/${t}$`)), `analytics page ${t}`);
    for (const t of routes.AUTOMATION_FOLDERS) assert.ok(has(new RegExp(`^/automations/${t}$`)), `automations folder ${t}`);
    for (const t of ['needs', 'saved', 'artifacts', 'chats']) assert.ok(has(new RegExp(`^/inbox/${t}$`)), `inbox folder ${t}`);
});

test('every nav tab is a page', () => {
    const tabs = [...read('templates/index.html').matchAll(/<button class="tab top-nav-tab[^>]*id="nav-tab-([a-z-]+)"/g)].map(m => m[1]);
    assert.ok(tabs.length >= 8, `read only ${tabs}`);
    for (const t of tabs) assert.ok(ids.has(NAV_TAB_PAGE[t]), `nav tab ${t} has no page (NAV_TAB_PAGE)`);
    for (const t of Object.keys(NAV_TAB_PAGE)) assert.ok(tabs.includes(t), `NAV_TAB_PAGE names ${t}, which is not a tab`);
});

test('every Settings section has a page', () => {
    const groups = [...read('templates/includes/modals.html').matchAll(/class="settings-pane"[^>]*data-group="([^"]+)"/g)].map(m => m[1]);
    assert.ok(groups.length >= 8, `read only ${groups}`);
    for (const g of groups) assert.ok(ids.has('settings-' + g), `Settings section ${g} has no page`);
    for (const p of PAGES.filter(x => x.open === 'settings')) assert.ok(groups.includes(p.group), `${p.id}: ${p.group} is not a section`);
});

test('every dialog is a page or has a reason it is not', () => {
    const modals = [...read('templates/includes/modals.html').matchAll(/<div id="([a-z-]+-modal)"/g)].map(m => m[1]);
    assert.ok(modals.length >= 15, `read only ${modals}`);
    for (const m of modals) {
        const why = NOT_PHOTOGRAPHED.modals[m];
        assert.ok(MODAL_PAGE[m] ? ids.has(MODAL_PAGE[m]) : typeof why === 'string' && why.length > 10, `dialog #${m} is neither a page (MODAL_PAGE) nor excused (NOT_PHOTOGRAPHED.modals)`);
    }
    for (const m of Object.keys(MODAL_PAGE)) assert.ok(modals.includes(m), `MODAL_PAGE names #${m}, which is not a dialog`);
    for (const [m, why] of Object.entries(NOT_PHOTOGRAPHED.modals)) assert.ok(why === null ? MODAL_PAGE[m] : modals.includes(m) || m === 'jump-status', `NOT_PHOTOGRAPHED.modals names ${m}`);
});

test('the first-run pages are the only ones on the fresh server', () => {
    for (const p of PAGES.filter(x => x.world === 'fresh')) assert.match(p.id, /^first-run-/);
    assert.ok(PAGES.filter(x => x.world === 'fresh').length >= 1);
});
