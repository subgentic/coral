// Automations, the Queue folder with a POOL (#13719, UI review of step 1): `heavy` is made of `mac-heavy` and `mini`; each of its holds says which machine it got, on a phone card as well as a desktop row, with the lease and the Stuck
// word kept; the member's own list carries the pool's hold too (its slot is in use) but the folder shows that hold once, under the pool; a change of machine alone redraws the table. Stubbed /api/resources as the server sends it. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const now = Date.now();
const iso = ms => new Date(now + ms).toISOString();
const macHold = { id: 31, agent: 'Dev On Mac', member: 'mac-heavy', machine: 'Mac', note: 'go test ./...', enqueued_at: iso(-900000), granted_at: iso(-800000), lease_until: iso(1500000) };
const miniHold = { id: 32, agent: 'Dev On Mini', member: 'mini', machine: 'Mini', stuck: 'prompt', stuck_min: 12, note: 'node run_cdp_suites.mjs', enqueued_at: iso(-1200000), granted_at: iso(-1100000), lease_until: iso(1200000) };
const QUEUE = [
    { name: 'heavy', slots: 3, members: ['mac-heavy', 'mini'], max_lease_seconds: 2700, holders: [macHold, miniHold], queue: [{ id: 33, agent: 'Dev Waiting', enqueued_at: iso(-60000), place: 1 }] },
    { name: 'mac-heavy', slots: 2, machine: 'Mac', max_lease_seconds: 2700, holders: [macHold], queue: [] }, // the pool's hold on it: its slot is in use, the row is under the pool
    { name: 'mini', slots: 1, machine: 'Mini', max_lease_seconds: 2700, holders: [miniHold], queue: [] },
];
const STUB = `(() => { const real = window.fetch; window.__queueTickMs = 1000; window.__queue = ${JSON.stringify(QUEUE)}; window.fetch = (u, o) => /\\/api\\/resources$/.test(String(u)) && (!o || !o.method || o.method === 'GET') ? Promise.resolve(new Response(JSON.stringify({ resources: window.__queue }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : real(u, o); })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`history.pushState(null, '', '/automations/queue'); window.dispatchEvent(new PopStateEvent('popstate')); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'three rows: the pool has two holds and one waiting, and its members show no duplicate of the holds: ' + (await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`)).join(' | '), 10000);
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            const text = rows.join(' | ');
            assert.equal((text.match(/Dev On Mac/g) || []).length, 1, at + "the pool's hold on the Mac member shows once, not under both: " + text);
            assert.equal((text.match(/Dev On Mini/g) || []).length, 1, at + 'and the mini one once: ' + text);
            // the machine, with the lease, on a phone card as on a desktop row; the Stuck word keeps its machine
            assert.match(text, /Dev On Mac.*Holding on Mac.*(2[0-9]|1[0-9]) min left/, at + 'a pool hold says Holding on Mac with its lease: ' + text);
            assert.match(text, /Dev On Mini.*Stuck 12 min on Mini.*(1[0-9]|2[0-9]) min left/, at + 'a stuck pool hold says Stuck and the machine, with its lease: ' + text);
            assert.match(text, /Dev Waiting.*(Waiting, place|Place) 1/, at + 'the pool has its one line');
            if (!mobile) {
                const fit = await ev(`(() => [...document.querySelectorAll('#group-table-view tbody tr[data-key]')].filter(r => /Dev On/.test(r.textContent)).map(r => { const c = r.querySelector('.dt-chip, [class*=chip]'); return c ? c.scrollWidth <= c.clientWidth + 1 : false; }))()`);
                assert.deepEqual(fit, [true, true], at + 'the state chip is not clipped on a desktop row: ' + JSON.stringify(fit));
            }
            const groups = await ev(`[...document.querySelectorAll('#group-table-view tr.dt-group th')].map(th => th.textContent.trim())`);
            assert.ok(groups.some(g => /^heavy: 3 of 3 in use, 1 waiting/.test(g) || /^heavy: 2 of 3 in use, 1 waiting/.test(g)), at + 'the pool group counts its members slots in use: ' + JSON.stringify(groups));
            // only the machine of a hold changes: the table is drawn again (the machine is part of what it shows)
            await ev(`window.__queue[0].holders[0] = { ...window.__queue[0].holders[0], machine: 'Mac Studio' }; true`);
            await waitFor(`/Holding on Mac Studio/.test(document.getElementById('group-table-view').textContent)`, at + 'a machine alone changing is drawn: ' + (await ev(`document.getElementById('group-table-view').textContent.replace(/\\s+/g, ' ').slice(0, 300)`)), 8000);
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
        }
        console.log('PASS the Queue folder with a pool: machine on desktop and phone, stuck, once under the pool, redraw on a machine change');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
