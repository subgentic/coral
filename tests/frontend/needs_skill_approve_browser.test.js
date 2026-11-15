// #17403: the Approve button on a Needs you skill row (no scripts) shows a confirm naming the file count, e.g. "Approve 4 files without opening?".
// A skill with scripts has no Approve button (only Review). A skill with no file_count has no Approve button (#18184).
// The singular "1 file" wording is tested alongside the plural "4 files". 1440 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const PENDING = [
    { id: '2'.repeat(32), name: 'db-review', version: 1, digest: 'b'.repeat(64), description: 'Checks a SQL migration.', status: 'pending', has_scripts: false, not_reviewable: false, scripts_acked: false, publisher_kind: 'agent', publisher_agent: 'Backend Dev', publisher_team: 'alpha', file_count: 4, created_at: '2026-11-02T09:00:00Z' },
    { id: '3'.repeat(32), name: 'risky-skill', version: 1, digest: 'c'.repeat(64), description: 'Has scripts.', status: 'pending', has_scripts: true, not_reviewable: false, scripts_acked: false, publisher_kind: 'agent', publisher_agent: 'Dev', publisher_team: 'beta', file_count: 2, created_at: '2026-11-02T08:00:00Z' },
    { id: '4'.repeat(32), name: 'one-file-skill', version: 1, digest: 'd'.repeat(64), description: 'One file.', status: 'pending', has_scripts: false, not_reviewable: false, scripts_acked: false, publisher_kind: 'agent', publisher_agent: 'Dev', publisher_team: 'alpha', file_count: 1, created_at: '2026-11-02T07:00:00Z' },
    { id: '5'.repeat(32), name: 'no-count-skill', version: 1, digest: 'e'.repeat(64), description: 'No file count.', status: 'pending', has_scripts: false, not_reviewable: false, scripts_acked: false, publisher_kind: 'agent', publisher_agent: 'Dev', publisher_team: 'alpha', created_at: '2026-11-02T06:00:00Z' },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => { const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin);
                if (p.pathname === '/api/skills' && p.searchParams.get('status') === 'pending') return json({ skills: ${JSON.stringify(PENDING)} });
                if (p.pathname === '/api/skills') return json({ skills: ${JSON.stringify(PENDING)} });
                if (p.pathname === '/api/skills/${PENDING[0].id}/approve' && (o.method || '').toUpperCase() === 'POST') return json({ ok: true });
                return real(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('hub-inbox', { folder: 'needs' }); true`);
        await waitFor(`/Skill to approve: db-review version 1/.test(document.getElementById('group-table-view').innerText)`, 'the skill rows in Needs you', 10000);

        // a no-scripts skill row has an Approve button
        const noScriptsRow = await ev(`(() => { const r = Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(x => /db-review/.test(x.textContent)); return r ? { buttons: Array.from(r.querySelectorAll('button')).map(b => b.textContent.trim()) } : null; })()`);
        assert.ok(noScriptsRow, 'the no-scripts skill row exists');
        assert.ok(noScriptsRow.buttons.includes('Approve'), 'a no-scripts skill row has an Approve button');
        assert.ok(noScriptsRow.buttons.includes('Review'), 'it still has Review too');

        // a skill with scripts has only Review, no Approve
        const scriptsRow = await ev(`(() => { const r = Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(x => /risky-skill/.test(x.textContent)); return r ? { buttons: Array.from(r.querySelectorAll('button')).map(b => b.textContent.trim()) } : null; })()`);
        assert.ok(scriptsRow, 'the scripts skill row exists');
        assert.ok(!scriptsRow.buttons.includes('Approve'), 'a skill with scripts has no Approve button');
        assert.ok(scriptsRow.buttons.includes('Review'), 'it has Review');

        // clicking Approve opens a confirm that names the file count
        await ev(`Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(r => /db-review/.test(r.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Approve') b.click(); }); true`);
        await waitFor(`document.getElementById('confirm-modal') && document.getElementById('confirm-modal').style.display === 'flex' && /4 files/.test(document.getElementById('confirm-modal').textContent)`, 'the confirm dialog names the file count', 5000);
        const dialog = await ev(`document.getElementById('confirm-modal').textContent`);
        assert.match(dialog, /Approve 4 files without opening/, 'the title names the count');
        assert.match(dialog, /db-review/, 'the body names the skill');

        // dismiss the confirm so the next assertions start clean
        await ev(`(() => { const m = document.getElementById('confirm-modal'); if (m) { const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }); m.dispatchEvent(esc); } return true; })()`);

        // a skill with 1 file uses the singular wording
        const oneFileRow = await ev(`(() => { const r = Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(x => /one-file-skill/.test(x.textContent)); return r ? { buttons: Array.from(r.querySelectorAll('button')).map(b => b.textContent.trim()) } : null; })()`);
        assert.ok(oneFileRow, 'the one-file skill row exists');
        assert.ok(oneFileRow.buttons.includes('Approve'), 'a 1-file skill has an Approve button');
        await ev(`Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(r => /one-file-skill/.test(r.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Approve') b.click(); }); true`);
        await waitFor(`document.getElementById('confirm-modal') && document.getElementById('confirm-modal').style.display === 'flex' && /1 file/.test(document.getElementById('confirm-modal').textContent)`, 'the singular confirm', 5000);
        const oneDialog = await ev(`document.getElementById('confirm-modal').textContent`);
        assert.match(oneDialog, /Approve 1 file without opening/, 'the singular wording says "1 file"');
        assert.ok(!/1 files/.test(oneDialog), 'does not say "1 files"');
        await ev(`(() => { const m = document.getElementById('confirm-modal'); if (m) { const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }); m.dispatchEvent(esc); } return true; })()`);

        // a skill with no file_count has no Approve button (#18184)
        const noCountRow = await ev(`(() => { const r = Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(x => /no-count-skill/.test(x.textContent)); return r ? { buttons: Array.from(r.querySelectorAll('button')).map(b => b.textContent.trim()) } : null; })()`);
        assert.ok(noCountRow, 'the no-count skill row exists');
        assert.ok(!noCountRow.buttons.includes('Approve'), 'a skill with no file_count has no Approve button');
        assert.ok(noCountRow.buttons.includes('Review'), 'it still has Review');

        console.log('PASS needs you skill row approve names the file count (#17403, #18184)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
