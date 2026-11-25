// Settings > Storage and backup: the Artifact store line and the Received files line are read after the pane opens (GET /api/system/artifact-store). The store line said "Loading…" on one line and then
// took two (the size, then the diffs), so the limit rows under it moved 15 px as it filled (#21400, found by #21381 in the layout-shift log). The answers are held here, every row of the pane is
// measured before and after they arrive, and nothing moves, whether the store is under its limit or past it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const GIB = 1024 ** 3;
const ANSWERS = [
    ['under the limit', { bytes: 3 * GIB, max_bytes: 10 * GIB, objects: 120, task_diffs: { bytes: 2 * GIB, files: 40 }, session_diffs: { bytes: GIB, files: 9 }, received: { bytes: GIB / 2, max_bytes: 2 * GIB, unlisted: { count: 0 } } }],
    ['no limit set', { bytes: 12 * GIB, max_bytes: 0, objects: 800, task_diffs: { bytes: 0, files: 0 }, session_diffs: { bytes: 0, files: 0 }, received: { bytes: 0, max_bytes: 0, unlisted: { count: 0 } } }],
];

(async () => {
    const { client, Page, ev, waitFor } = await connect();
    const measure = () => ev(`(() => {
        const pane = document.getElementById('settings-pane-cleanup');
        const top = e => Math.round(e.getBoundingClientRect().top * 10) / 10;
        return [...pane.querySelectorAll('.sv-row, #settings-storage-actions')].filter(r => r.getClientRects().length).map(r => (r.id || (r.querySelector('[id]') || {}).id || r.className) + '@' + top(r));
    })()`);
    try {
        await Page.enable();
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.showSettingsModal === 'function'`, 'the dashboard', 10000);
        for (const [name, answer] of ANSWERS) {
            await ev(`window.__held = new Promise(r => { window.__release = r; });
                window.__answer = ${JSON.stringify(answer)};
                if (!window.__realFetch) { window.__realFetch = window.fetch.bind(window); window.fetch = (u, o) => { const s = String(u);
                    if (s.includes('/api/system/artifact-store') && !s.includes('/kept') && (!o || !o.method || o.method === 'GET')) return window.__held.then(() => new Response(JSON.stringify(s.includes('detail=1') ? { detail: { by_age: {}, by_board: [], retention: { days: 0, kinds: 'diffs' } } } : window.__answer), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    return window.__realFetch(u, o); }; }
                true`);
            await ev(`(async () => { await showSettingsModal('cleanup'); return true; })()`);
            await waitFor(`(() => { const d = document.getElementById('settings-artifact-store-size'); return !!d && d.offsetParent !== null; })()`, 'the store line', 8000);
            // the pane's other lazy blocks come in their own time: wait until nothing above the answer's rows moves, with the answers still held
            let before = await measure();
            for (let i = 0, still = 0; still < 3 && i < 100; i++) { await new Promise(r => setTimeout(r, 100)); const now = await measure(); still = JSON.stringify(now) === JSON.stringify(before) ? still + 1 : 0; before = now; } // sleep-ok: settling a pane that other blocks fill, bounded to 10 s
            assert.equal(await ev(`document.getElementById('settings-artifact-store-size').textContent.startsWith('Loading')`), true, `${name}: the answer is still held`);
            await ev(`window.__release(); true`);
            await waitFor(`!document.getElementById('settings-artifact-store-size').textContent.startsWith('Loading') && !document.getElementById('settings-received-size').textContent.startsWith('Loading') && document.getElementById('settings-storage-detail').textContent.length >= 0 && !document.getElementById('settings-prune-days').disabled`, `the answers are drawn (${name})`, 8000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: lets any late line land before the second measure
            const after = await measure();
            const moved = after.map((a, i) => (before[i] === a ? null : `${before[i]} -> ${a}`)).filter(Boolean);
            assert.deepEqual(moved, [], `${name}: the rows of the pane stay where they were while the size lines fill`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.showSettingsModal === 'function'`, 'the dashboard again', 10000);
        }
        console.log('PASS settings_storage_no_shift: the Storage pane does not move while its size lines fill');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
