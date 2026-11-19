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
            window.__rows = [{ id: 1, at: new Date(Date.now() - 240000).toISOString(), team: 'tm', action: 'approve', item_kind: 'file', item_id: '${HEX}', version: '${HEX}', title: 'plan.md', note: 'Orchestrator was told', source: 'dashboard', file_n: 1, file_latest_n: 2, file_versions: [{ n: 1, digest: '${HEX}', at: new Date(Date.now() - 240000).toISOString() }, { n: 2, digest: '${'b'.repeat(64)}', at: new Date(Date.now() - 60000).toISOString() }] }];
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
        await waitFor(`document.querySelectorAll('#group-table-view .al-row').length === 1`, 'the one action');
        await ev(`document.querySelector('#group-table-view .al-row button.al-title').click(); true`);
        await waitFor(`!!document.querySelector('dialog.activity-file-dialog[open]')`, 'the file dialog opens', 8000);
        const d = await ev(`(() => { const x = document.querySelector('dialog.activity-file-dialog'); return { head: x.querySelector('h2').textContent, file: x.querySelector('.activity-file-name').textContent, said: x.querySelector('.activity-file-said').textContent, buttons: [...x.querySelectorAll('.activity-thread-actions .btn')].map(b => [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()), icons: [...x.querySelectorAll('.activity-thread-actions .btn .material-icons')].map(i => i.textContent), placeholder: x.querySelector('textarea').placeholder, attach: /Attach image/.test(x.textContent), hint: /Paste or drop/.test(x.textContent), boxes: x.querySelectorAll('textarea').length }; })()`);
        assert.match(d.head, /Approved$/); assert.equal(d.file, 'plan.md'); assert.match(d.said, /Orchestrator was told/);
        for (const b of ['Copy link', 'Reopen for review', 'Open file']) assert.ok(d.buttons.includes(b), `${b}: ${JSON.stringify(d.buttons)}`);
        assert.equal(d.buttons[d.buttons.length - 1], 'Open file', 'Open file is the right-most button');
        assert.deepEqual(d.icons, ['link', 'replay', 'description'], 'Copy link, Reopen for review and Open file carry the mock\'s icons'); assert.equal(d.placeholder, 'Add a follow-up comment on plan.md…');
        // #19871 (MUST-13): the file's tile, the verdict as a pill, the feedback in a tinted callout, the versions as a card
        const m = await ev(`(() => { const x = document.querySelector('dialog.activity-file-dialog'); return { tile: !!x.querySelector('.al-tile.al-fk-markdown'), pill: x.querySelector('h2 .al-verdict.al-v-approve')?.textContent, label: x.querySelector('.al-answer .al-ans-label')?.textContent, rows: [...x.querySelectorAll('.activity-file-series-row')].map(r => r.textContent), head: x.querySelector('.activity-file-series-head')?.textContent, pills: [...x.querySelectorAll('.activity-file-series .al-vchip')].map(e => e.textContent) }; })()`);
        assert.equal(m.tile, true, 'the dialog draws the file kind tile'); assert.equal(m.pill, 'Approved', 'the verdict is a pill by the name'); assert.equal(m.label, 'Your feedback on v1: ');
        { const h = await ev(`(() => { const c = getComputedStyle(document.querySelector('.activity-file-series-head')); return [parseFloat(c.fontSize), Number(c.fontWeight)]; })()`); assert.ok(h[0] <= 12 && h[1] <= 500, `the series heading is small and light as the mock's: ${h}`); }
        assert.equal(m.head, 'Versions in this series (2)'); assert.equal(m.rows.length, 2, JSON.stringify(m)); assert.match(m.rows[0], /^v2/); assert.match(m.rows[1], /^v1/); assert.deepEqual(m.pills, ['Latest', 'Reviewed here']);
        assert.ok(d.attach && d.hint && d.boxes === 1, JSON.stringify(d));
        // a comment
        await ev(`(() => { const t = document.querySelector('.activity-file-dialog textarea'); t.value = 'Looks good, thanks.'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.activity-file-comment').click(); return true; })()`);
        await waitFor(`window.__calls.includes('comment:Looks good, thanks.')`, 'the comment is sent', 8000);
        // Reopen for review
        await ev(`[...document.querySelectorAll('.activity-file-dialog .btn')].find(b => b.textContent.trim().endsWith('Reopen for review')).click(); true`);
        await waitFor(`window.__calls.includes('review') && !document.querySelector('dialog.activity-file-dialog')`, 'Reopen for review sends the file for review and shuts the dialog', 8000);
        console.log('PASS activity file dialog');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
