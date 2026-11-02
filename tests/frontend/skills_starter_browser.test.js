// The example skills Coral ships (#12463) in the Skills tab: published by "Coral (example)", approved, and with no Remove: the view says it stays and Coral refreshes it. A skill an Operator published
// keeps its Remove. The routes are stood in at /api/skills. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const mk = (id, name, kind) => ({ id: id.repeat(32), name, version: 1, digest: id.repeat(64), description: 'About ' + name + '.', status: 'approved', has_scripts: false, not_reviewable: false,
    publisher_kind: kind, publisher_agent: '', publisher_team: '', file_count: 1, created_at: '2026-11-02T09:00:00Z', decided_at: '2026-11-02T09:00:00Z' });
const ROWS = [mk('1', 'release-notes', 'operator'), mk('4', 'working-in-a-coral-team', 'coral')];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`(() => {
            const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            const rows = ${JSON.stringify(ROWS)};
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin); const m = (o.method || 'GET').toUpperCase(); const p = url.pathname;
                if (!p.startsWith('/api/skills')) return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
                if (p === '/api/skills' && m === 'GET') { const st = url.searchParams.get('status'); return json({ skills: st ? rows.filter(r => r.status === st) : rows }); }
                const row = rows.find(r => p === '/api/skills/' + r.id);
                if (row && m === 'GET') return json({ skill: row, files: [{ path: 'SKILL.md', size: 90, kind: 'instructions', sha256: '9'.repeat(64) }], contents: { 'SKILL.md': '# ' + row.name }, warnings: [], hosts: [] });
                return json({ error: 'not found' }, 404); };
            return true; })()`);
        await ev(`window.switchNavTab('skills'); true`);
        await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 2`, 'two skills in the table', 8000);
        const by = await ev(`Array.from(document.querySelectorAll('#skills-view tr.dt-row')).map(r => [r.dataset.key, r.innerText])`);
        assert.match(by.find(([k]) => k === ROWS[1].id)[1], /Coral \(example\)/, 'the example is published by Coral (example): ' + JSON.stringify(by));
        assert.match(by.find(([k]) => k === ROWS[0].id)[1], /Operator/, 'a skill the Operator published says so');

        const remove = `Array.from(document.querySelectorAll('#skills-view .skills-actions button')).some(b => /^Remove/.test(b.textContent))`;
        await ev(`document.querySelector('#skills-view tr.dt-row[data-key="${ROWS[0].id}"]').click(); true`);
        await waitFor(`/release-notes/.test(document.getElementById('skills-view').innerText) && ${remove}`, 'the Operator\'s skill keeps its Remove', 6000);

        await ev(`Array.from(document.querySelectorAll('#skills-view button')).find(b => /^All skills/.test(b.textContent))?.click(); true`);
        await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 2`, 'back to the list', 6000);
        await ev(`document.querySelector('#skills-view tr.dt-row[data-key="${ROWS[1].id}"]').click(); true`);
        await waitFor(`/An example from Coral/.test(document.getElementById('skills-view').innerText)`, 'the example says it stays', 6000);
        assert.equal(await ev(remove), false, 'an example has no Remove');
        console.log('PASS the Skills tab: Coral examples are published by Coral (example) and cannot be removed; an Operator\'s skill keeps Remove');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
