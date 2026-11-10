// The keyboard stays in the comments after a send (#15174, Beta walk 7 H2: after Send in a review comment and after Reply, the focus dropped to the page body and the next Tab started from the top): a reply sent with
// Ctrl+Enter leaves the keyboard on a control of the panel (the thread's Reply box), not on the page. Stubbed comments API. 1280 px.
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HEX = 'c'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client, S = `(window.__coralStatic || '/static/')`, problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        await ev(`(() => { const real = window.fetch, ago = ms => new Date(Date.now() - ms).toISOString();
            const mk = (id, parent, body, mine) => ({ id, parent_id: parent, anchor: parent ? null : { quote: 'The plan.', start_line: 3, end_line: 3 }, body, author: { kind: mine ? 'owner' : 'agent', issuer: 'local', subject: mine ? 'Operator' : 'Lead' }, created_at: ago(300000 - id * 1000) });
            window.__cs = [mk(1, null, 'Is this right?', true)];
            const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
            const can = c => ({ reply: c.parent_id == null, edit: false, delete: false, resolve: c.parent_id == null });
            window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
                if (url.includes('/api/artifacts/${HEX}/comments')) {
                    if (method === 'GET') return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: c.author.kind === 'owner', can: can(c) })), locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
                    if (method === 'POST') { const b = JSON.parse(o.body), c = mk(10 + window.__cs.length, b.parent_id == null ? null : b.parent_id, b.body, true); window.__cs.push(c); return json({ ...c, mine: true, can: can(c) }); }
                }
                if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response('# Plan\\n\\nThe plan.\\n', { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                return real(u, o); }; return true; })()`);
        await ev(`import(${S} + 'safe_storage.js').then(({ browserLocal }) => { browserLocal.set('coral-artifact-comments-open', 'open'); browserLocal.set('coral-artifact-comments:text/markdown', 'open'); return true; })`);
        await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', board: 'kb-team' })); true`);
        await waitFor(`!!document.querySelector('.ac-card[data-id="1"] .ac-replybox')`, 'the thread', 10000);
        await ev(`document.querySelector('.ac-card[data-id="1"] .ac-replybox').click(); true`);
        await waitFor(`!!document.querySelector('.ac-card .ac-input')`, 'the reply box', 4000);
        await ev(`(() => { const ta = document.querySelector('.ac-card .ac-input'); ta.focus(); ta.value = 'Thanks'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 2 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
        await waitFor(`window.__cs.length === 2 && !document.querySelector('.ac-card .ac-input')`, 'the reply is sent and the box is gone', 8000);
        await ev(`new Promise(r => setTimeout(r, 500))`); // sleep-ok: the panel is drawn again
        const where = await ev(`(() => { const a = document.activeElement; return { body: !a || a === document.body, inPanel: !!a && !!a.closest('.ac-panel'), name: a ? (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 40) : '' }; })()`);
        if (where.body || !where.inPanel) problems.push('after Ctrl+Enter send the keyboard is not in the comments: ' + JSON.stringify(where));
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('comment_send_focus_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
