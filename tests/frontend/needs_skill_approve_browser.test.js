// #22094: skill ledger selectors and opening folded groups; publisher sanitization, source reads, Review navigation and no-scripts approval confirm retained.
// #17403: the Approve button on a Needs you skill row (no scripts) shows a confirm naming the file count, e.g. "Approve 4 files without opening?".
// A skill with scripts has no Approve button (only Review). 1440 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const PENDING = [
    { id: '2'.repeat(32), name: 'db-review', version: 1, digest: 'b'.repeat(64), description: 'Checks a SQL migration.', status: 'pending', has_scripts: false, not_reviewable: false, scripts_acked: false, publisher_kind: 'agent', publisher_agent: 'Backend Dev', publisher_team: 'alpha', file_count: 4, created_at: '2026-11-02T09:00:00Z' },
    { id: '3'.repeat(32), name: 'risky-skill', version: 1, digest: 'c'.repeat(64), description: 'Has scripts.', status: 'pending', has_scripts: true, not_reviewable: false, scripts_acked: false, publisher_kind: 'agent', publisher_agent: 'Dev', publisher_team: 'beta', file_count: 2, created_at: '2026-11-02T08:00:00Z' },
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
        await waitFor(`/Skill to approve: db-review version 1/.test(document.getElementById('group-table-view').textContent)`, 'the skill rows in Needs you', 10000);
        await ev(`document.querySelectorAll('.nl-group-toggle[aria-expanded=false]').forEach(b=>b.click());true`);

        // a no-scripts skill row has an Approve button
        const noScriptsRow = await ev(`(() => { const r = Array.from(document.querySelectorAll('#group-table-view .nl-row')).find(x => /db-review/.test(x.textContent)); return r ? { buttons: Array.from(r.querySelectorAll('button')).map(b => b.textContent.trim()) } : null; })()`);
        assert.ok(noScriptsRow, 'the no-scripts skill row exists');
        assert.ok(noScriptsRow.buttons.includes('Approve'), 'a no-scripts skill row has an Approve button');
        assert.ok(noScriptsRow.buttons.includes('Review'), 'it still has Review too');

        // a skill with scripts has only Review, no Approve
        const scriptsRow = await ev(`(() => { const r = Array.from(document.querySelectorAll('#group-table-view .nl-row')).find(x => /risky-skill/.test(x.textContent)); return r ? { buttons: Array.from(r.querySelectorAll('button')).map(b => b.textContent.trim()) } : null; })()`);
        assert.ok(scriptsRow, 'the scripts skill row exists');
        assert.ok(!scriptsRow.buttons.includes('Approve'), 'a skill with scripts has no Approve button');
        assert.ok(scriptsRow.buttons.includes('Review'), 'it has Review');

        // clicking Approve opens a confirm that names the file count
        await ev(`Array.from(document.querySelectorAll('#group-table-view .nl-row')).find(r => /db-review/.test(r.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Approve') b.click(); }); true`);
        await waitFor(`document.getElementById('confirm-modal') && document.getElementById('confirm-modal').style.display === 'flex' && /4 files/.test(document.getElementById('confirm-modal').textContent)`, 'the confirm dialog names the file count', 5000);
        const dialog = await ev(`document.getElementById('confirm-modal').textContent`);
        assert.match(dialog, /Approve 4 files without opening/, 'the title names the count');
        assert.match(dialog, /db-review/, 'the body names the skill');

        console.log('PASS needs you skill row approve names the file count (#17403)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
