// #15792 (the Operator's mockup v3): a file decision in Activity opens a dialog: what was decided, ONE comment box that takes pictures, and the buttons Copy link, Reopen for review (the file's own Send for
// review: PUT .../artifacts/<hex>/review) and Open file (the viewer); Send comment writes a whole-file comment. The record and the routes are stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HEX = 'a'.repeat(64);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => {
            const prefix = window.__coralStatic || '/static/', json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
            window.__rows = [{ id: 1, at: new Date(Date.now() - 240000).toISOString(), team: 'tm', action: 'approve', item_kind: 'file', item_id: '${HEX}', version: '${HEX}', title: 'plan.md', note: 'Orchestrator was told', source: 'dashboard' }];
            window.__calls = [];
            const original = window.fetch;
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname === '/api/activity') return json({ actions: window.__rows, check: { intact: true, rows: 1 } });
                if (u.pathname === '/api/board/tm/artifacts/${HEX}/review' && opts.method === 'PUT') { window.__calls.push('review'); return json({ tags: ['for review'] }); }
                if (u.pathname.endsWith('/comments') && opts.method === 'POST') { window.__calls.push('comment:' + JSON.parse(opts.body).body); return json({ id: 1, body: JSON.parse(opts.body).body, anchor: { whole: true }, replies: [] }); }
                return original(url, opts); };
            localStorage.removeItem('coral-inbox-activity-filters');
            window.switchNavTab('hub-inbox');
            await (await import(prefix + 'inbox_sidebar.js')).openInboxGroup('activity');
        })()`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, 'the one action');
        await ev(`document.querySelector('#group-table-view tbody tr button.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('dialog.activity-file-dialog[open]')`, 'the file dialog opens', 8000);
        const d = await ev(`(() => { const x = document.querySelector('dialog.activity-file-dialog'); return { head: x.querySelector('h2').textContent, file: x.querySelector('.activity-file-name').textContent, said: x.querySelector('.activity-file-said').textContent, buttons: [...x.querySelectorAll('.activity-thread-actions .btn')].map(b => b.textContent.trim()), attach: /Attach image/.test(x.textContent), hint: /Paste or drop/.test(x.textContent), boxes: x.querySelectorAll('textarea').length }; })()`);
        assert.equal(d.head, 'Approved'); assert.equal(d.file, 'plan.md'); assert.match(d.said, /Orchestrator was told/);
        for (const b of ['Copy link', 'Reopen for review', 'Open file']) assert.ok(d.buttons.includes(b), `${b}: ${JSON.stringify(d.buttons)}`);
        assert.equal(d.buttons[d.buttons.length - 1], 'Open file', 'Open file is the right-most button');
        assert.ok(d.attach && d.hint && d.boxes === 1, JSON.stringify(d));
        // a comment
        await ev(`(() => { const t = document.querySelector('.activity-file-dialog textarea'); t.value = 'Looks good, thanks.'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.activity-file-comment').click(); return true; })()`);
        await waitFor(`window.__calls.includes('comment:Looks good, thanks.')`, 'the comment is sent', 8000);
        // Reopen for review
        await ev(`[...document.querySelectorAll('.activity-file-dialog .btn')].find(b => b.textContent.trim() === 'Reopen for review').click(); true`);
        await waitFor(`window.__calls.includes('review') && !document.querySelector('dialog.activity-file-dialog')`, 'Reopen for review sends the file for review and shuts the dialog', 8000);
        console.log('PASS activity file dialog');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
