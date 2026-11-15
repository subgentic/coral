// Send to agent on a file of an agent with no team (#18105, the Operator): the sheet does not say "agents on Not on a team ... lists no agent". It offers the one agent that uploaded the file, ticked, with Send to agent
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
                    return json({ comments: [{ id: 1, parent_id: null, anchor: null, body: 'Please add the Q4 table.', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date().toISOString(), deleted: false, mine: true, can: { reply: true, edit: false, delete: false, resolve: true } }], locked: false, you: { can_comment: true, can_lock: true }, limits: {} });
                }
                if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response('# Report', { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                return real(u, o);
            };
            return true; })()`);
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'report.md', board: '~no-team' }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
        await waitFor(`document.querySelectorAll('.ac-card').length >= 1`, 'the thread', 8000);
        await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`); await sleep(300); // sleep-ok: the panel opens
        await waitFor(`!!document.querySelector('.ac-card[data-id="1"] .ac-ask-open')`, 'Send to agent is offered on a no-team file', 8000);
        await ev(`document.querySelector('.ac-card[data-id="1"] .ac-ask-open').click(); true`);
        await waitFor(`!!document.querySelector('.ac-ask .ac-ask-agent')`, 'the sheet offers an agent', 8000);
        const b = await ev(`(() => { const x = document.querySelector('.ac-ask'); return { title: x.querySelector('.ac-ask-title').textContent, text: x.textContent, agents: [...x.querySelectorAll('.ac-ask-agent input')].map(i => ({ role: i.value, checked: i.checked })), go: x.querySelector('.ac-ask-go').textContent, disabled: x.querySelector('.ac-ask-go').disabled }; })()`);
        await shot('no-team-send-sheet');
        assert.ok(!/Not on a team/.test(b.text) && !/lists no agent/.test(b.text), 'the sheet never reads "Not on a team" as a board or "lists no agent": ' + b.text);
        assert.equal(b.title, 'Send this comment to the agent that uploaded this file');
        assert.deepEqual(b.agents, [{ role: 'the agent that uploaded this file', checked: true }], 'one agent, ticked');
        assert.equal(b.go, 'Send to agent'); assert.equal(b.disabled, false, 'Send to agent is enabled');
        await ev(`document.querySelector('.ac-ask .ac-ask-go').click(); true`);
        await waitFor(`window.__sends.length === 1`, 'the send went out', 8000);
        assert.deepEqual(await ev('window.__sends[0]'), ['the agent that uploaded this file']);
        await waitFor(`/Asked/.test(document.querySelector('.ac-ask')?.textContent || '')`, 'the sheet says Asked', 8000);
        assert.equal(await ev(`document.querySelector('.ac-card[data-id="1"] .ac-ask-status').textContent`), 'Sent to the agent that uploaded this file', 'the thread agrees with the sheet and the toast: it is not "Not sent to an agent yet"');
        console.log('artifact_comment_send_no_team: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
