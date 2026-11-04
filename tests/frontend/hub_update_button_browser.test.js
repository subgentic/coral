// #13258: the Update badge of a computer on the Hub's Computers view is a button that updates it. A stub Hub (the computer's status and its relaunch and check routes behind /api/remote/<id>/): the badge is a button; with the person's switch
// off it says where to turn it on and opens nothing; with an update staged and verified it opens the confirmation and the Update and relaunch button sends the relaunch to THAT computer; with nothing checked it asks the computer to check (one POST,
// no body) and, once the computer has staged one, opens the confirmation. Nothing is sent without the confirmation.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(() => { const R = window.fetch; window.__calls = []; window.__reply = {}; window.__after = {}; window.__checked = {}; window.__sent = [];
            const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname, method = (o.method || 'GET').toUpperCase();
                if (p === '/api/servers') return json({ servers: [{ id: 'm1', label: 'Alpha', online: true, access_mode: 'launch', local_mode: 'launch', created_at: '2026-10-01T00:00:00Z', last_seen: '2026-10-20T08:00:00Z' }] });
                let m = /^\\/api\\/remote\\/([^/]+)\\/api\\/system\\/update$/.exec(p);
                if (m) { window.__calls.push('STATUS ' + m[1]); const r = (window.__checked[m[1]] && window.__after[m[1]]) || window.__reply[m[1]]; return r ? json(r, 200) : json({}, 404); }
                m = /^\\/api\\/remote\\/([^/]+)\\/api\\/system\\/update\\/check-hub$/.exec(p);
                if (m) { window.__calls.push('CHECK ' + m[1]); window.__sent.push({ method, body: o.body === undefined ? null : o.body, search: url.search }); window.__checked[m[1]] = true; return json({ ok: true, state: 'checking' }, 202); }
                m = /^\\/api\\/remote\\/([^/]+)\\/api\\/system\\/update\\/relaunch$/.exec(p);
                if (m) { window.__calls.push('RELAUNCH ' + m[1]); return json({ ok: true, operation: 'op' }, 202); }
                return R(u, o); };
            const host = document.createElement('div'); host.id = 'ub-host'; document.body.appendChild(host); return true; })()`);
        await ev(`import(${S} + 'state.js').then(m => { m.state.hub = true; m.state.servers = [{ id: 'm1', status: 'online', update: 'available', latest_coral: '1.4.131', coral_version: '1.4.100' }]; return true; })`);
        await ev(`import(${S} + 'servers.js').then(m => m.renderServersInto(document.getElementById('ub-host'), { source: 'cloud' }))`);
        await waitFor(`!!document.querySelector('#ub-host .server-update-badge')`, 'the update badge is on the row', 8000);
        assert.equal(await ev(`document.querySelector('#ub-host .server-update-badge').tagName`), 'BUTTON', 'the badge is a button, not a link');
        const press = () => ev(`document.querySelector('#ub-host .server-update-badge').click(); true`);
        const dialogOpen = () => ev(`(() => { const d = document.getElementById('update-confirm-modal'); return !!d && d.style.display !== 'none'; })()`);
        const closeDialog = () => ev(`(() => { const d = document.getElementById('update-confirm-modal'); if (d) d.style.display = 'none'; window.__calls.length = 0; return true; })()`);

        // 1: the person's switch is off on that computer: words, where to turn it on, nothing opens, nothing sent
        await ev(`window.__reply.m1 = { enabled: true, installed: '1.4.100', state: 'none', hub_state: 'hub_relaunch_off', relaunch: { available: false, reason: 'hub_relaunch_off', restarts: [] } }; true`);
        await press();
        await waitFor(`/relaunch to install updates/.test(document.body.innerText)`, 'the words say where to turn it on', 6000);
        assert.equal(await dialogOpen(), false, 'no confirmation');
        assert.ok(!(await ev(`window.__calls.some(c => /^(RELAUNCH|CHECK)/.test(c))`)), 'nothing was sent but the status read');

        // 2: staged and verified: the confirmation, and its button sends the relaunch to that computer
        await ev(`window.__reply.m1 = { enabled: true, installed: '1.4.100', state: 'staged', hub_state: 'staged', staged: { version: '1.4.131', verified: true, staged_at: '2026-11-04T08:00:00Z', days_ready: 0 }, relaunch: { available: true, ack: 'ack-1', restarts: [{ session_id: 's1', name: 'Dev', state: 'working' }] } }; true`);
        await press();
        await waitFor(`document.getElementById('update-confirm-modal') && document.getElementById('update-confirm-modal').style.display !== 'none'`, 'the confirmation opens', 6000);
        assert.ok(/Dev/.test(await ev(`document.getElementById('update-confirm-modal').innerText`)), 'it names what restarts');
        assert.ok(!(await ev(`window.__calls.some(c => /^RELAUNCH/.test(c))`)), 'nothing is sent before the person confirms');
        await ev(`document.querySelector('#update-confirm-modal .update-go').click(); true`);
        await waitFor(`window.__calls.includes('RELAUNCH m1')`, 'the relaunch went to that computer', 6000);
        await closeDialog();

        // 3: nothing checked yet: the computer is asked to check (one POST, no body, no query), then looked at again; once it has staged an update the confirmation opens
        await ev(`window.__checked = {}; window.__reply.m1 = { enabled: true, installed: '1.4.100', state: 'none', hub_state: 'not_checked', relaunch: { available: false, reason: 'nothing_staged', restarts: [] } };
            window.__after.m1 = { enabled: true, installed: '1.4.100', state: 'staged', hub_state: 'staged', staged: { version: '1.4.131', verified: true, staged_at: '2026-11-04T08:00:00Z', days_ready: 0 }, relaunch: { available: true, ack: 'ack-2', restarts: [] } }; true`);
        await press();
        await waitFor(`window.__calls.includes('CHECK m1')`, 'the computer was asked to check', 6000);
        const sent = await ev(`window.__sent`);
        assert.equal(sent.length, 1); assert.equal(sent[0].method, 'POST'); assert.equal(sent[0].body, null, 'no body'); assert.equal(sent[0].search, '', 'no query');
        await waitFor(`document.getElementById('update-confirm-modal') && document.getElementById('update-confirm-modal').style.display !== 'none'`, 'once it has staged one, the confirmation opens', 20000);
        assert.ok(!(await ev(`window.__calls.some(c => /^RELAUNCH/.test(c))`)), 'and still nothing is relaunched without the person');
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
