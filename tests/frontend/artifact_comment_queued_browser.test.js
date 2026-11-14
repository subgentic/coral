// (#14860) A comment held for a busy agent says so: "Queued for <agent>, delivers when it's free", then Sent to it once the server has delivered it (ask.queued off).
// Style of artifact_comment_read_status_browser (#14129, the Operator: "I'd like this to tell me when the agent has read the message"): Sent to A -> Read by A, <time> (the server saw the agent's own read call
// return the comment: asks[].read_at) -> A replied. Never "unread": a view with no read_at (a guest's, or an older server's) says only Sent. The line moves on by itself while the panel is open (the panel's own poll).
// 1280 and 390 px. The comments are stubbed at the page's fetch, with the asks the server's view carries. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'f'.repeat(64);
const MD = ['# Plan', '', 'A plan to read.', ''].join('\n');
const ago = ms => new Date(Date.now() - ms).toISOString();
const ASK = (agent, extra = {}) => ({ agent, open: true, replies: 0, seen: false, nudged: false, ...extra });
const COMMENTS = [
    { id: 1, parent_id: null, anchor: { whole: true }, body: 'Held: the agent is mid-task.', asks: [ASK('Writer Q', { queued: true })] },
    { id: 2, parent_id: null, anchor: { whole: true }, body: 'Not held.', asks: [ASK('Writer R')] },
].map(c => ({ ...c, author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: ago(20 * 60000) }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.clear(); globalThis.__coralCommentsPollMs = 300; window.__cs = ${JSON.stringify(COMMENTS)}; (() => { const real = window.fetch, json = (o, s = 200) => Promise.resolve(new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (url.includes('/api/artifacts/${HEX}/comments') && m === 'GET') return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: true, can: { reply: true, edit: false, delete: false, resolve: true } })), locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
                    if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                    return real(u, o); }; return true; })()`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', board: 'ask-team' }); return true; })()`);
            await waitFor(`!!document.querySelector('.ac-toggle')`, `${at}the comments toggle`, 8000);
            await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#artifact-viewer .ac-card').length >= 2`, `${at}the two comments`, 8000);
            const line = id => ev(`(document.querySelector('#artifact-viewer .ac-card[data-id="${id}"] .ac-ask-status')?.textContent || '').replace(/\\s+/g, ' ').trim()`);
            check(await line(1) === "Queued for Writer Q, delivers when it's free", `${at}a held comment says Queued for the agent: ` + JSON.stringify(await line(1)));
            check(/^Sent to Writer R\b/.test(await line(2)) && !/Queued/.test(await line(2)), `${at}a comment that is not held says Sent: ` + JSON.stringify(await line(2)));
            await ev(`window.__cs[0].asks[0].queued = false; true`); // the agent became free: the server delivered it
            await waitFor(`/^Sent to Writer Q\\b/.test((document.querySelector('#artifact-viewer .ac-card[data-id="1"] .ac-ask-status')?.textContent || '').trim())`, `${at}the line moves from Queued to Sent by itself`, 8000);
            check(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `${at}no horizontal overflow`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a comment held for a busy agent says Queued for it, and Sent once delivered');
})().catch(e => { console.error(e); process.exit(1); });
