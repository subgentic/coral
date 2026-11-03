// The Inbox's Artifacts list on a Hub-served page (mode cloud: there is no local computer) never says "No artifacts yet" for a read that has not finished or that could not be made (#12672, QA's SHOULD 6):
// the list of computers not loaded yet is "Loading artifacts…" (the read waits), no computer online and every computer failing are said as failures, and only a computer that answered with nothing gets
// the empty words. jsdom with the real app shell: node inbox_artifacts_loading.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
let plan = {};
globalThis.fetch = window.fetch = async (url) => {
    const u = new URL(String(url), 'https://hub.example/');
    if (u.pathname === '/api/system/artifact-store/kept') return new Response(JSON.stringify({ kept: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const m = /^\/api\/remote\/([^/]+)\/api\/team-artifacts$/.exec(u.pathname);
    assert.ok(m, `an unexpected request: ${u.pathname}`);
    const p = plan[m[1]] || {};
    if (p.status) return new Response(JSON.stringify({ error: 'boom' }), { status: p.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ artifacts: [], teams: [], total: 0, all: 0, has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const { state } = await importUi('state');
const { createArtifactsList } = await importUi('team_artifacts_page');
const until = async f => { for (let i = 0; i < 300 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };

const mount = async (servers) => {
    state.hub = true; state.servers = servers;
    const list = createArtifactsList({ inbox: true });
    const host = document.createElement('div'); document.body.append(host);
    list.showArtifacts(host, '@inbox', {});
    return { list, host, line: () => (host.querySelector('.team-count-line') || {}).textContent || '' };
};
const online = ids => ids.map(id => ({ id, label: id.toUpperCase(), status: 'online' }));

// the list of computers has not loaded: loading, and it stays loading
let { host, line } = await mount(undefined);
await new Promise(r => setTimeout(r, 150)); // sleep-ok: the test shows the page stays loading when nothing more arrives, which only waiting can show
assert.match(line(), /Loading artifacts/, line());
assert.doesNotMatch(host.textContent, /No artifacts yet/, 'a read that is not finished says nothing of "no artifacts"');

// no computer online: the failure line
plan = {};
({ host, line } = await mount([{ id: 'srv1', label: 'SRV1', status: 'offline' }]));
await until(() => /No linked computer is online/.test(line()));
assert.match(line(), /No linked computer is online/, line());
assert.doesNotMatch(host.textContent, /No artifacts yet/);

// every computer failing: the failure line
plan = { srv1: { status: 500 }, srv2: { status: 502 } };
({ host, line } = await mount(online(['srv1', 'srv2'])));
await until(() => /could not be read/.test(line()));
assert.match(line(), /could not be read/, line());
assert.doesNotMatch(host.textContent, /No artifacts yet/);

// a computer that answered with nothing: the empty words, and only then
plan = {};
({ host, line } = await mount(online(['srv3'])));
await until(() => /No artifacts yet/.test(line()));
assert.match(line(), /No artifacts yet/, line());
console.log('inbox_artifacts_loading: ok');
process.exit(0);
