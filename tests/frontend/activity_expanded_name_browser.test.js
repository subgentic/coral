// The Activity cards write out the hidden characters of an agent's name, as every other place a name is shown does (#18244, Security's INFO on #17452): a zero-width space in the asker's name reads <U+200B>, it is never drawn.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const detail2 = t => t;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { const base = { actor: 'operator', team: 'coral-hub', source: 'local', version: '', hint: '', surface: '' };
            window.__rows = [{ id: 1, action: 'answer', item_kind: 'question', item_id: '7', title: '@Operator Which design?', asker: 'Orch\\u200Bestrator', note: 'Opt\\u200Bion 2', at: new Date(Date.now() - 60000).toISOString(), ...base },
                { id: 2, action: 'prompt_allow', item_kind: 'agent', item_id: 'sid-2', title: 'Dev\\u200Beloper', note: '', at: new Date(Date.now() - 120000).toISOString(), ...base },
                { id: 3, action: 'wait_send', item_kind: 'agent', item_id: 'sid-3', title: 'Wai\\u200Bter', note: '', at: new Date(Date.now() - 180000).toISOString(), ...base, team: 'te\\u200Bam' }];
            const real = window.fetch; window.fetch = (u, o) => new URL(String(u), location.origin).pathname === '/api/activity' ? Promise.resolve(new Response(JSON.stringify({ actions: window.__rows, check: { intact: true, rows: 1 } }), { headers: { 'Content-Type': 'application/json' } })) : real(u, o);
            localStorage.removeItem('coral-inbox-activity-filters'); window.switchNavTab('hub-inbox'); return import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('activity')).then(() => true); })()`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr.activity-card').length === 3`, 'the cards', 15000);
        const detail = await ev(`[...document.querySelectorAll('.activity-folder tr.activity-card')].map(d => d.textContent).join(' | ')`); // the cards show the words whole: there is no expanded row
        assert.ok(!detail.includes('​'), 'no raw zero-width space in the cards: ' + JSON.stringify(detail));
        assert.ok(detail.includes('Orch<U+200B>estrator'), 'the card writes the hidden character out of the asker: ' + JSON.stringify(detail));
        assert.ok(detail.includes('Dev<U+200B>eloper'), 'and out of the agent name an ON line is built from (a permission row): ' + JSON.stringify(detail));
        // every other cell an agent's words reach, in the table (#18275, Security's INFO on #18244): the ON line and the detail of a waiting card (its title), the recorded note (an answer's text), the team
        const all = await ev(`document.querySelector('.activity-folder').textContent + ' ' + [...document.querySelectorAll('.activity-folder [aria-label], .activity-folder [title]')].map(e => (e.getAttribute('aria-label') || '') + (e.title || '')).join(' ')`);
        assert.ok(!all.includes('\u200b'), 'no raw zero-width space anywhere in the Activity table or its labels: ' + JSON.stringify(all.slice(0, 400)));
        for (const word of ['Wai<U+200B>ter', 'Opt<U+200B>ion 2', 'te<U+200B>am']) assert.ok(detail2(all).includes(word), `${word} is written out: ` + JSON.stringify(all.slice(0, 600)));
        console.log('activity_expanded_name_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
