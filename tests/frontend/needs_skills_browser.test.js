// A skill waiting for approval is an item of the Inbox's Needs you (#12139, goal #191): one row for each with who published it, counted in the Inbox tab's badge, a pill for the kind, and Review opens the Skills tab at
// that skill. The Skills Store's list is stood in at GET /api/skills?status=pending. 1440 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const PENDING = [
    { id: '2'.repeat(32), name: 'db-review', version: 1, digest: 'b'.repeat(64), description: 'Checks a SQL migration.', status: 'pending', has_scripts: false, not_reviewable: false, publisher_kind: 'agent', publisher_agent: 'Backend Dev', publisher_team: 'alpha', created_at: '2026-11-02T09:00:00Z' },
    { id: '3'.repeat(32), name: 'pdf-forms', version: 2, digest: 'c'.repeat(64), description: 'Fill PDF forms.', status: 'pending', has_scripts: false, not_reviewable: false, publisher_kind: 'agent', publisher_agent: 'Dev', publisher_team: 'beta', created_at: '2026-11-02T08:00:00Z' },
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
                if (p.pathname === '/api/skills/${PENDING[0].id}') return json({ skill: ${JSON.stringify(PENDING[0])}, files: [], contents: {}, warnings: [], hosts: [] });
                return real(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('hub-inbox', { folder: 'needs' }); true`);
        await waitFor(`/Skill to approve: db-review version 1/.test(document.getElementById('group-table-view').innerText)`, 'the skill rows in Needs you', 10000);
        const text = await ev(`document.getElementById('group-table-view').innerText`);
        assert.match(text, /Skill to approve: pdf-forms version 2/);
        assert.match(text, /Published by Backend Dev · alpha/, 'who published it, from the session');
        assert.match(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`), /^[2-9]\d*$/, 'the Inbox tab counts them');
        assert.match(await ev(`Array.from(document.querySelectorAll('#group-table-view button')).map(b => b.textContent.trim()).join('|')`), /Review/, 'a Review button on the row');
        // Review opens the Skills tab at that skill
        await ev(`Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(r => /db-review/.test(r.textContent)).querySelector('button.btn').click(); true`);
        await waitFor(`location.pathname === '/skills/${PENDING[0].id}'`, 'the Skills tab at that skill', 8000);
        console.log('PASS a skill waiting for approval is an item of Needs you');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
