// Settings > Network: the "Manage other computers from this one" row is read after the pane opens (GET /api/system/hub-mode). Its status line used to take no room while empty and some when the answer came,
// so the pane moved under the person's eyes as it loaded (#21385, found by #21381 in teardown_stability). The answer is held here, the row's box and everything below it are measured before and after it arrives,
// and nothing moves, whether the answer says nothing (off) or has one line to say (a running hub).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor } = await connect();
    const measure = () => ev(`(() => {
        const row = document.getElementById('settings-hub-mode-enabled').closest('.sv-row'), pane = document.getElementById('settings-pane-network');
        const rows = [...pane.querySelectorAll('.sv-row')].filter(r => r.getClientRects().length), at = rows.indexOf(row);
        const top = e => Math.round(e.getBoundingClientRect().top * 10) / 10;
        return { rowTop: top(row), rowHeight: Math.round(row.getBoundingClientRect().height * 10) / 10, below: rows.slice(at + 1).map(top) }; // the pane's own height also takes the other lazy blocks (the join keys), which are not this row's
    })()`);
    try {
        await Page.enable();
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.showSettingsModal === 'function'`, 'the dashboard', 10000);
        // the two answers a load brings: off (nothing to say) and a running hub (one line). A saved change that waits for a restart is two lines, and it comes from the person's own switch, not from the load.
        for (const [name, answer, said] of [['off', { saved: false, running: false, forced: false, restart_required: false, can_restart: false }, false], ['a running hub', { saved: true, running: true, forced: false, restart_required: false, can_restart: false }, true]]) {
            await ev(`window.__held = new Promise(r => { window.__release = r; });
                window.__answer = ${JSON.stringify(answer)};
                if (!window.__realFetch) { window.__realFetch = window.fetch.bind(window); window.fetch = (u, o) => (String(u).includes('/api/system/hub-mode') && (!o || !o.method || o.method === 'GET') ? window.__held.then(() => new Response(JSON.stringify(window.__answer), { status: 200, headers: { 'Content-Type': 'application/json' } })) : window.__realFetch(u, o)); }
                true`);
            await ev(`(async () => { await showSettingsModal('network'); return true; })()`);
            await waitFor(`(() => { const d = document.getElementById('settings-hub-mode-enabled'); return !!d && d.offsetParent !== null; })()`, 'the hub mode row', 8000);
            // the pane's other lazy blocks (the join keys, the Hub's own state) come in their own time, and on a browser that has been here before they can land after the pane shows: wait until what is above the row has stopped moving, with this row's answer still held
            let before = await measure();
            for (let i = 0, still = 0; still < 3 && i < 100; i++) { await new Promise(r => setTimeout(r, 100)); const now = await measure(); still = JSON.stringify(now) === JSON.stringify(before) ? still + 1 : 0; before = now; } // sleep-ok: settling a pane that other blocks fill, bounded to 10 s
            await ev(`window.__release(); true`);
            await waitFor(`document.getElementById('settings-hub-mode-enabled').checked === ${answer.saved} && (${!said} || document.getElementById('settings-hub-mode-status').textContent.length > 0)`, `the answer is drawn (${name})`, 8000);
            const after = await measure();
            // a running hub also brings its own blocks above the row (the join keys), which is content, not a late line: its top is only compared where the answer adds none
            assert.equal(after.rowHeight, before.rowHeight, `${name}: the row keeps its height when the answer arrives`);
            if (!said) assert.deepEqual(after, before, `${name}: the row and the rows under it stay where they were when the answer arrives`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.showSettingsModal === 'function'`, 'the dashboard again', 10000);
        }
        console.log('PASS settings_hub_mode_no_shift: the Network pane does not move when the hub-mode answer arrives');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
