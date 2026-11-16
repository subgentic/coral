// A linked computer's queue is read only (#17559): its task and goal are plain text, and so is its team (#18546: the team name was still a button). This computer's own queue keeps the team button.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const iso = ms => new Date(Date.now() + ms).toISOString();
            const mk = who => ({ resources: [{ name: 'mac-heavy', slots: 1, machine: 'Mac', holders: [{ id: 1, agent: who, note: 'go test', task: 7, project: 'p', goal_id: 3, goal_title: 'A goal', granted_at: iso(-60000), lease_until: iso(1500000) }], queue: [] }] });
            window.__q = { local: mk('Local Agent'), 'box-2': mk('Remote Agent') };
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = /^\\/api\\/remote\\/([^/]+)\\/api\\/resources$/.exec(url.pathname), id = m ? m[1] : (url.pathname === '/api/resources' ? 'local' : null);
                if (id && (!o.method || o.method === 'GET')) return Promise.resolve(new Response(JSON.stringify(window.__q[id]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); };
            return true; })()`);
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Build box', status: 'online', last_seen: new Date().toISOString() }]; return true; })()`);
        await ev(`window.switchNavTab('queue'); true`);
        const team = `document.querySelector('#queue-tab-body tr[data-key] .queue-team')`;
        await waitFor(`/Local Agent/.test((document.getElementById('queue-tab-body') || {}).textContent || '') && !!${team}`, "this computer's queue", 10000);
        assert.equal(await ev(`${team}.tagName`), 'BUTTON', "this computer's own queue: the team opens its page");
        await ev(`(() => { const s = document.querySelector('#queue-tab-body select'); s.value = 'box-2'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`/Remote Agent/.test((document.getElementById('queue-tab-body') || {}).textContent || '') && !!${team}`, "the linked computer's queue", 10000);
        assert.equal(await ev(`${team}.tagName`), 'SPAN', "a linked computer's queue is read only: its team is plain text");
        assert.equal(await ev(`${team}.textContent.trim().length > 0`), true, 'with the team name');
        assert.equal(await ev(`document.querySelectorAll('#queue-tab-body tr[data-key] button, #queue-tab-body tr[data-key] a[href]').length`), 0, 'nothing in a read-only row is a button or a link');
        console.log('PASS queue_readonly_team_plain_browser');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
