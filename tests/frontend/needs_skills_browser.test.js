// A skill waiting for approval is an item of the Inbox's Needs you (#12139, goal #191): one row for each with who published it, counted in the Inbox tab's badge, a pill for the kind, and Review opens the Skills tab at
// that skill. The Skills Store's list is stood in at GET /api/skills?status=pending. 1440 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const PENDING = [
    { id: '2'.repeat(32), name: 'db-review', version: 1, digest: 'b'.repeat(64), description: 'Checks a SQL migration.', status: 'pending', has_scripts: false, not_reviewable: false, publisher_kind: 'agent', publisher_agent: 'Backend Dev', publisher_team: 'alpha', created_at: '2026-11-02T09:00:00Z' },
    { id: '3'.repeat(32), name: 'pdf-forms', version: 2, digest: 'c'.repeat(64), description: 'Fill PDF forms.', status: 'pending', has_scripts: false, not_reviewable: false, publisher_kind: 'agent', publisher_agent: 'Dev', publisher_team: 'beta', created_at: '2026-11-02T08:00:00Z' },
    // words an agent chose: a control character, zero-width ones and a reordering override, in the skill's name and in the publisher's agent and team (#12260, QA's SHOULD on #12104)
    { id: '4'.repeat(32), name: 'clean\u0007-up\u200b-skill\u202e', version: 1, digest: 'd'.repeat(64), description: 'Tidy.', status: 'pending', has_scripts: false, not_reviewable: false, publisher_kind: 'agent', publisher_agent: 'Evil\u200d Agent\u0000\u2066', publisher_team: 'te\u202eam\u200b', created_at: '2026-11-02T07:00:00Z' },
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
        // a name or a publisher with a control, zero-width or reordering character comes out clean: none of those characters is in what is drawn (they are dropped or written out, never passed to the page)
        const row = await ev(`(() => { const r = Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(x => /clean/.test(x.textContent)); return r ? { text: r.textContent, html: r.innerHTML, title: r.getAttribute('aria-label') || '' } : null; })()`);
        assert.ok(row, 'the row of the skill with hostile characters is there');
        const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
        assert.equal(bad.test(row.text), false, 'no control, zero-width or reordering character in the row text: ' + JSON.stringify(row.text));
        assert.equal(bad.test(row.html), false, 'nor in the row markup: ' + JSON.stringify((row.html.match(/.{0,60}[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff].{0,30}/g) || []).slice(0, 3)));
        assert.match(row.text, /Skill to approve: clean/, 'the words that are words are there');
        assert.match(row.text, /Evil/, 'the publisher is there');
        // The same at 390 px (#12272): the phone's row draws its title and lead from the skill's name, and the Filters panel lists the names: none of them may carry a hidden character either
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('needs')).then(() => true)`);
        await waitFor(`/clean/.test(document.getElementById('group-table-view')?.textContent || '') && innerWidth === 390`, 'the phone rows', 10000);
        const phoneView = await ev(`(() => ({ rows: document.getElementById('group-table-view').textContent, html: document.getElementById('group-table-view').innerHTML, bar: document.querySelector('#inbox-view') ? document.querySelector('#inbox-view').innerHTML : '', w: innerWidth }))()`);
        assert.equal(phoneView.w, 390, 'the phone width was the one checked');
        assert.equal(bad.test(phoneView.rows), false, 'no hidden character in the phone rows: ' + JSON.stringify(phoneView.rows.slice(0, 400)));
        assert.equal(bad.test(phoneView.html), false, 'nor in the phone rows\' markup (the title, the lead, the labels)');
        assert.equal(bad.test(phoneView.bar), false, 'nor anywhere in the Inbox page, the Filters panel and its list of names included');
        assert.match(phoneView.rows, /clean<U\+0007>-up<U\+200B>-skill<U\+202E>/, 'the words that are words are there, the rest written out');
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await ev(`window.switchNavTab('hub-inbox', { folder: 'needs' }); true`);
        await waitFor(`/Skill to approve: db-review version 1/.test(document.getElementById('group-table-view').innerText)`, 'the desktop rows again', 10000);
        assert.match(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`), /^[2-9]\d*$/, 'the Inbox tab counts them');
        assert.match(await ev(`Array.from(document.querySelectorAll('#group-table-view button')).map(b => b.textContent.trim()).join('|')`), /Review/, 'a Review button on the row');
        // Review opens the Skills tab at that skill
        await ev(`Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(r => /db-review/.test(r.textContent)).querySelector('button.btn').click(); true`);
        await waitFor(`location.pathname === '/skills/${PENDING[0].id}'`, 'the Skills tab at that skill', 8000);
        console.log('PASS a skill waiting for approval is an item of Needs you');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
