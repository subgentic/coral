// The team page's "Linked teams" section (#16011, the Operator via coral-hub: "having the team link outside of the main workflow is not ideal"): under the team's header, on every tab, when this Coral is linked to
// a Coral Hub, the team's links in both directions (from GET /api/board/{team}/cross-team-state: links = teams that can message this one, links_out = teams this one can message) and a link out to Coral Hub's Team links
// page to add one. Hidden when no Hub is linked and when the state cannot be read. Labels are text, never markup. Isolated dev server; the cloud status and the state are stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-linked-${Date.now() % 100000}`;
const SID = 'ab12cd34ef56gh78';
const HUB = 'https://hub.example.test:8443'; // a self-hosted Hub, not app.coralhub.dev
const STATE = {
    status: { state: 'ready', text: 'Linked' }, linkable: true,
    links: [{ server_id: 'srv-1', server_label: 'Mac mini', team_id: 'b-aaaaaaaaaa', team_label: 'Design team', refreshed: '2026-11-13T10:00:00Z' }],
    links_out: [{ server_id: 'srv-2', team_id: 'b-bbbbbbbbbb', team_label: 'Docs <img src=x onerror="window.__pwned=1"> team', refreshed: '2026-11-13T10:00:00Z' }],
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    // hub: the /api/cloud/status state; stateAnswer: {status, body} for the team's cross-team-state
    const stub = (hub, stateAnswer, hubUrl) => ev(`(() => { window.__hub = ${JSON.stringify(hub)}; window.__hubUrl = ${JSON.stringify(hubUrl === undefined ? HUB : hubUrl)}; window.__xt = ${JSON.stringify(stateAnswer)}; if (window.__linkStub) return true; window.__linkStub = true; const R = window.fetch.bind(window);
        const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const get = String((o && o.method) || 'GET').toUpperCase() === 'GET';
            if (get && url.pathname === '/api/cloud/status') return j({ state: window.__hub, server_id: ${JSON.stringify(SID)}, hub_url: window.__hubUrl });
            if (get && url.pathname === ${JSON.stringify(`/api/board/${TEAM}/cross-team-state`)}) return j(window.__xt.body, window.__xt.status);
            return R(u, o); }; return true; })()`);
    const section = () => ev(`(() => { const s = [...document.querySelectorAll('#team-page-view [aria-label="Linked teams"]')].find(e => window.__na.vis(e)); if (!s) return null;
        const a = [...s.querySelectorAll('a')].map(x => ({ text: x.textContent.replace(/\\s+/g, ' ').trim(), href: x.getAttribute('href'), target: x.getAttribute('target'), rel: x.getAttribute('rel') }));
        return { text: s.textContent.replace(/\\s+/g, ' ').trim(), links: a, rows: [...s.querySelectorAll('li')].map(l => l.textContent.replace(/\\s+/g, ' ').trim()), imgs: s.querySelectorAll('img').length, pwned: !!window.__pwned }; })()`);
    const open = async (hub, answer, hubUrl) => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'settings'); await installTP(ev);
        await seed(ev, TEAM); await stub(hub, answer, hubUrl);
        await openTeam(ev, waitFor, TEAM).catch(() => {}); await settle(1200);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`).catch(() => {});
            await open('connected', { status: 200, body: STATE });
            await S.run(`${label}: linked to a Hub: both directions are listed, as text, with the computer each team is on`, async () => {
                await waitFor(`!!document.querySelector('#team-page-view [aria-label="Linked teams"] li')`, 'the section lists the links', 8000);
                const s = await section();
                assert.equal(s.rows.length, 2, 'one row per link, both directions: ' + JSON.stringify(s.rows));
                assert.ok(s.rows.some(r => /Design team/.test(r) && /Mac mini/.test(r) && /message/i.test(r)), 'the team that can message this one, with its computer: ' + JSON.stringify(s.rows));
                assert.ok(s.rows.some(r => /Docs/.test(r) && /<img/.test(r)), 'the team this one can message: its label is shown as text: ' + JSON.stringify(s.rows));
                assert.equal(s.imgs, 0, 'a label is never markup'); assert.equal(s.pwned, false);
            });
            await S.run(`${label}: a link out to Coral Hub's Team links page, in a new tab, safely`, async () => {
                const s = await section();
                const a = s.links.find(l => /Coral Hub/i.test(l.text));
                assert.ok(a, 'a link names Coral Hub: ' + JSON.stringify(s.links));
                assert.equal(a.href, HUB + '/team-links', 'the Hub this Coral is linked to, not app.coralhub.dev'); assert.equal(a.target, '_blank'); assert.match(a.rel, /noopener/); assert.match(a.rel, /noreferrer/);
            });
            await S.run(`${label}: it stays on every tab`, async () => {
                for (const name of ['Tasks', 'Agents', 'Goals']) { await goTab(ev, settle, name); await settle(300); assert.ok(await section(), `the section is there on ${name}`); }
            });
            await open('connected', { status: 200, body: { ...STATE, links: [], links_out: [] } });
            await S.run(`${label}: linked to a Hub, no links yet: it says so and offers the link out to add one`, async () => {
                await waitFor(`!!document.querySelector('#team-page-view [aria-label="Linked teams"]') && window.__na.vis(document.querySelector('#team-page-view [aria-label="Linked teams"]'))`, 'the section is shown', 8000);
                const s = await section();
                assert.equal(s.rows.length, 0); assert.match(s.text, /no linked teams/i); assert.ok(s.links.some(l => l.href === HUB + '/team-links'), 'the way to add one');
            });
            await open('connected', { status: 200, body: STATE }, 'https://hub.example.test/some/path?team=x#frag');
            await S.run(`${label}: only the Hub's address is used: no path, query or team data`, async () => {
                await waitFor(`!!document.querySelector('#team-page-view [aria-label="Linked teams"] li')`, 'the section lists the links', 8000);
                const s = await section(); const a = s.links.find(l => /Coral Hub/i.test(l.text));
                assert.equal(a.href, 'https://hub.example.test/team-links');
            });
            await open('connected', { status: 200, body: STATE }, 'javascript:alert(1)');
            await S.run(`${label}: an unusable Hub address: the rows stay, there is no link out`, async () => {
                await waitFor(`!!document.querySelector('#team-page-view [aria-label="Linked teams"] li')`, 'the section lists the links', 8000);
                const s = await section(); assert.equal(s.rows.length, 2); assert.equal(s.links.length, 0, JSON.stringify(s.links));
            });
            await open('disabled', { status: 200, body: STATE });
            await S.run(`${label}: no Hub linked: nothing is drawn`, async () => {
                assert.equal(await section(), null, 'no section, no heading, no text');
                assert.equal(await ev(`document.querySelector('#team-page-links') ? document.querySelector('#team-page-links').hidden : true`), true);
            });
            await open('connected', { status: 403, body: { error: 'owner_only' } });
            await S.run(`${label}: the state cannot be read: nothing is drawn`, async () => { assert.equal(await section(), null); });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
