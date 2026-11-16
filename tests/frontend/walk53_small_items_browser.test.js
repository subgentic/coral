// Small items of walk 53 (#17169), each held against the real page on the isolated server, 1280 px:
//  1. while the "No connection, retrying" bar is up, the team header does not say "No agent has sent a first message yet" (an agent that cannot be read is not one that has not written): it says "Reconnecting"; the bar gone, the old words return.
//  2. a model pick says "Switching to <model>…" at once and keeps saying it past the first two seconds while the agent has not confirmed; a second pick meanwhile is ignored (it sent /model twice).
//  3. Settings > Notifications: turning Desktop alerts on says so and shows "Send a test alert"; the button raises one alert.
// Drives Chrome over CDP through agent_view_harness.js. The browser's Notification is a stub that records what was raised; the model route is stubbed (POST answers 202 after 300 ms).
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

const TEAM = `qa-w53-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const wait = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the chip's own two-second timer must really pass; there is no event for it
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const NOTIFICATION = `(() => { window.__alerts = []; window.Notification = class { constructor(t, o) { window.__alerts.push([t, o]); } close() {} static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } }; })();`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: NOTIFICATION });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);

        // 1. the team header while the connection bar is up
        await seed(ev, TEAM);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = async (u, o = {}) => { const url = new URL(String(u), location.origin); const r = await R(u, o);
            if (!/^\\/api\\/board\\/[^/]+\\/status$/.test(url.pathname) || !r.ok) return r;
            const d = await r.clone().json().catch(() => null); if (!d || !Array.isArray(d.agents)) return r;
            d.agents = d.agents.map(a => ({ ...a, availability: 'unknown', available: false, reason: '' }));
            return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(1500);
        await waitFor(`/first message/.test((document.getElementById('team-page-status') || {}).textContent || '')`, 'the status has settled (it reads "Checking attention status" until the read answers or its deadline passes)', 20000);
        const words = () => ev(`(document.getElementById('team-page-status') || {}).textContent || ''`);
        const before = await words();
        check(/first message/.test(before), 'with the feed up an unread team says it has no first message yet: ' + JSON.stringify(before));
        await ev(`(() => { const b = document.createElement('div'); b.id = 'connection-bar'; b.className = 'notice notice-warn notice-bar connection-bar'; b.textContent = 'No connection, retrying'; document.body.prepend(b); document.dispatchEvent(new CustomEvent('coral:needs-updated')); return true; })()`);
        await settle(400);
        await waitFor(`/Reconnecting/.test((document.getElementById('team-page-status') || {}).textContent || '')`, 'the header says Reconnecting', 10000).catch(() => {}); // the check below says what it read if not
        const down = await words();
        check(/Reconnecting/.test(down) && !/first message/.test(down), 'with the connection bar up the header says Reconnecting, not that no agent has written: ' + JSON.stringify(down));
        await ev(`(() => { document.getElementById('connection-bar').remove(); document.dispatchEvent(new CustomEvent('coral:needs-updated')); return true; })()`);
        await settle(400);
        check(/first message/.test(await words()), 'the bar gone, the header says what it said before: ' + JSON.stringify(await words()));

        // 2. the model chip: Switching at once, held past 2 s, a second pick ignored
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await ev(`(() => { const R = window.fetch; window.__posts = 0;
            const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/agents/models') return Promise.resolve(json({ agent_type: 'claude', thinking: [], models: [{ value: 'haiku', display_name: 'Haiku' }, { value: 'opus', display_name: 'Opus' }], refreshing: false }));
                if (/\\/api\\/sessions\\/live\\/[^/]+\\/model$/.test(url.pathname) && o.method === 'POST') { window.__posts++; return new Promise(res => setTimeout(() => res(json({ ok: true }, 202)), 300)); }
                return R(u, o); };
            window.__m.add('sw-claude', 'C', 3, { sleeping: false, agent_type: 'claude' }); T.render.renderLiveSessions(T.state.liveSessions);
            T.ws.handleCoralMessage({ type: 'coral_diff', changed: [{ ...window.__m.entry(window.__m.agents['sw-claude-id']), agent_type: 'claude', model: 'sonnet' }] }); return true; })()`);
        await select('sw-claude');
        await waitFor(`!document.getElementById('model-chip-bar').hidden`, 'the model chip', 8000);
        const pick = m => ev(`(() => { const it = document.querySelector('#model-chip-menu .model-chip-item[data-model="${m}"]'); if (!it) return false; it.click(); return true; })()`);
        await ev(`document.getElementById('model-chip').click(); true`);
        await waitFor(`!!document.querySelector('#model-chip-menu .model-chip-item[data-model="haiku"]')`, 'the model list', 8000);
        await pick('haiku');
        check(/Switching to/.test(await ev(`document.getElementById('model-chip-text').textContent`)), 'the chip says Switching at once');
        await wait(2800); // sleep-ok: past the first two seconds, with the agent still on the old model
        const held = await ev(`document.getElementById('model-chip-text').textContent`);
        check(/Switching to/.test(held), 'the chip still says Switching after 2.8 s while the agent has not confirmed: ' + JSON.stringify(held));
        await ev(`document.getElementById('model-chip').click(); true`);
        await waitFor(`!!document.querySelector('#model-chip-menu .model-chip-item[data-model="opus"]') && !document.getElementById('model-chip-menu').hidden`, 'the menu open again', 8000);
        check(await pick('opus'), 'the second pick was made'); await wait(600); // sleep-ok: a repeat pick sends nothing; there is no event for "nothing happened"
        check((await ev(`window.__posts`)) === 1, 'a second pick while one is on its way sends nothing more: ' + (await ev(`window.__posts`)) + ' sent');

        // 3. Settings > Notifications: the confirmation and the test alert
        await ev(`localStorage.removeItem('coral-desktop-notify'); (async () => { await window.showSettingsModal('notifications'); return true; })()`);
        await waitFor(`!!document.getElementById('settings-desktop-notify')`, 'the Desktop alerts switch', 10000);
        check(await ev(`(() => { const t = document.getElementById('settings-desktop-test'); return !t || t.hidden; })()`), 'with alerts off there is no test button');
        await ev(`document.getElementById('settings-desktop-notify').click(); true`);
        await waitFor(`document.getElementById('settings-desktop-notify').checked`, 'the switch on', 5000);
        await settle(300);
        const said = await ev(`(document.getElementById('settings-desktop-blocked') || {}).textContent || ''`);
        check(/Alerts are on/.test(said), 'turning it on says so: ' + JSON.stringify(said));
        const has = await ev(`(() => { const t = document.getElementById('settings-desktop-test'); return !!t && !t.hidden && t.textContent; })()`);
        check(has === 'Send a test alert', 'a Send a test alert button is there: ' + JSON.stringify(has));
        await ev(`(document.getElementById('settings-desktop-test') || { click() {} }).click(); true`);
        await waitFor(`window.__alerts.length >= 1`, 'a test alert is raised', 5000).catch(() => {});
        check((await ev(`window.__alerts.length`)) === 1, 'the button raises one alert: ' + (await ev(`window.__alerts.length`)));
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('walk53_small_items_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
