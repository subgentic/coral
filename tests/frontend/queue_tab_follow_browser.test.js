// #16141 (Security's two INFOs on #16030): (1) a Kick waiting for its second press does not keep the old table on screen when the picker changes: the picker's computer and the table agree, and nothing stays armed;
// (2) a linked computer's resources array is not trusted as to the shape of its elements: a null, a number or a string among them (or among a holder's or a waiting list) is skipped, the rest is drawn.
// Isolated dev server; the queue answers are stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const iso = ms => new Date(Date.now() + ms).toISOString();
            const res = (a, b) => ({ name: 'mac-heavy', slots: 1, machine: 'Mac', holders: [{ id: 1, agent: a, note: 'go test', task: 0, granted_at: iso(-60000), lease_until: iso(1500000) }], queue: [{ id: 2, agent: b, note: 'waiting', place: 1, enqueued_at: iso(-120000) }] });
            window.__q = { local: { resources: [res('Frontend Dev', 'QA Engineer')] }, 'box-2': { resources: [null, 3, 'x', [], { ...res('Remote Builder', 'Remote QA'), holders: [null, 7, { id: 1, agent: 'Remote Builder', note: 'x', granted_at: iso(-60000), lease_until: iso(1500000) }], queue: [null, { id: 2, agent: 'Remote QA', note: 'w', place: 1, enqueued_at: iso(-120000) }] }] } };
            window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason)));
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = /^\\/api\\/remote\\/([^/]+)\\/api\\/resources$/.exec(url.pathname), id = m ? m[1] : (url.pathname === '/api/resources' ? 'local' : null);
                if (id && (!o.method || o.method === 'GET')) return Promise.resolve(new Response(JSON.stringify(window.__q[id]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); };
            return true; })()`);
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Build box', status: 'online', last_seen: new Date().toISOString() }]; return true; })()`);
        await ev(`window.switchNavTab('queue'); true`);
        await waitFor(`document.querySelectorAll('#queue-tab-body tr[data-key]').length >= 2`, 'this computer\'s queue', 10000);
        const body = () => ev(`document.getElementById('queue-tab-body').textContent.replace(/\\s+/g, ' ')`);

        // 1: arm a Kick, then change the picker
        await ev(`[...document.querySelectorAll('#queue-tab-body .queue-act')].find(b => b.dataset.act === 'Kick').click(); true`);
        if (!(await ev(`!!document.querySelector('#queue-tab-body .queue-sure')`))) problems.push('the first press did not arm the Kick (the scenario needs it armed)');
        await ev(`(() => { const s = document.querySelector('#queue-tab-body select'); s.value = 'box-2'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`/Remote Builder/.test(document.getElementById('queue-tab-body').textContent)`, 'the linked computer\'s queue after the picker changed with a Kick armed', 8000).catch(e => problems.push(e.message.slice(0, 200)));
        let t = await body();
        if (/Frontend Dev/.test(t)) problems.push('the picker names the linked computer but the table is still this computer\'s: ' + t.slice(0, 200));
        if (await ev(`!!document.querySelector('#queue-tab-body .queue-sure')`)) problems.push('a Kick is still armed after the picker changed');
        if (await ev(`!!document.querySelector('#queue-tab-body .queue-act')`)) problems.push('a linked computer\'s queue has Move or Kick');
        // and back: this computer's rows are drawn again, with an unarmed Kick
        await ev(`(() => { const s = document.querySelector('#queue-tab-body select'); s.value = 'local'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`/Frontend Dev/.test(document.getElementById('queue-tab-body').textContent)`, 'this computer again', 8000).catch(e => problems.push(e.message.slice(0, 200)));
        if (await ev(`!!document.querySelector('#queue-tab-body .queue-sure')`)) problems.push('a Kick came back armed');

        // 2: the linked computer's answer holds elements that are not objects
        await ev(`(() => { const s = document.querySelector('#queue-tab-body select'); s.value = 'box-2'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`/Remote Builder/.test(document.getElementById('queue-tab-body').textContent)`, 'the linked computer\'s queue with odd elements', 8000).catch(e => problems.push('a null element stopped the table: ' + e.message.slice(0, 160)));
        t = await body();
        if (!/Remote QA/.test(t)) problems.push('the valid waiting entry is not drawn: ' + t.slice(0, 300));
        const errs = await ev(`window.__errs`);
        if (errs.length) problems.push('the page threw: ' + JSON.stringify(errs).slice(0, 300));
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS Queue tab follow-ups: an armed Kick is disarmed by the picker; odd elements in a remote queue are skipped');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
