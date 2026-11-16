// #18701 (Beta Tester, rc4e walk): after Request changes the comment in the thread said "Not sent to an agent yet" while the toast said it was sent. The Operator's "Changes requested: ..." comment (which the decision itself delivered) says it was sent; an ordinary comment nobody was asked into still says it was not.
// enabled, and sends the comment naming that agent (the server types it into the session). The comments and the send route are stood in at the page's fetch (the route is tested in internal/server/routes). 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'd'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} (() => {
            const real = window.fetch; window.__sends = [];
            const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => {
                const url = String(u), method = (o && o.method) || 'GET';
                if (url.includes('/api/artifacts/${HEX}/comments')) {
                    const sub = url.split('/comments')[1].split('?')[0];
                    if (method === 'POST' && /^\\/\\d+\\/send$/.test(sub)) { const b = JSON.parse(o.body); window.__sends.push(b.agents); return json({ ok: true, results: b.agents.map(a => ({ agent: a, state: 'sent' })) }); }
                    return json({ comments: [{ id: 1, parent_id: null, anchor: null, body: 'Changes requested: please add the Q4 table.', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date().toISOString(), deleted: false, mine: true, can: { reply: true, edit: false, delete: false, resolve: true } }, { id: 2, parent_id: null, anchor: null, body: 'A plain note.', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date().toISOString(), deleted: false, mine: true, can: { reply: true, edit: false, delete: false, resolve: true } }], locked: false, you: { can_comment: true, can_lock: true }, limits: {} });
                }
                if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response('# Report', { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                return real(u, o);
            };
            return true; })()`);
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'report.md', board: '~no-team' }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
        await waitFor(`document.querySelectorAll('.ac-card').length >= 1`, 'the thread', 8000);
        await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`); await sleep(300); // sleep-ok: the panel opens
        await waitFor(`!!document.querySelector('.ac-card[data-id="1"] .ac-ask-status')`, 'the status line', 8000);
        assert.equal(await ev(`document.querySelector('.ac-card[data-id="1"] .ac-ask-status').textContent`), 'Sent to the agent that uploaded this file', 'a Request changes comment says it was sent, as the toast does');
        assert.equal(await ev(`document.querySelector('.ac-card[data-id="2"] .ac-ask-status').textContent`), 'Not sent to an agent yet', 'an ordinary comment nobody was asked into still says it was not');
        console.log('review_changes_comment_sent: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
