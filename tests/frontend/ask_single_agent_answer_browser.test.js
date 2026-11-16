// #18202 (Security and QA SHOULD on #18106): answering a single agent's question (no team) from the Needs you dialog, end to end in the page. The question is a row in Needs you (kind "agent", no board); the dialog's
// Send reply posts {answer} to /api/agent-asks/<id>/answer (the route that types it into the agent's conversation); a refusal says "Not sent: <the server's words>", keeps the dialog and the typed text, and a second try
// works; on success the dialog closes, the page says the reply went, the list is read again and the row is gone. 1280 and 390 px. The agent's side (the text typed into its terminal) is the Go test's.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 }); await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { window.__posts = []; window.__lists = 0; window.__answered = false; window.__refuse = true;
                const ask = { board: '', asker: 'claude-4f2a', kind: 'agent', id: 7, at: new Date(Date.now() - 60000).toISOString(), text: 'Which database should the notes app use?', cut: false };
                const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                const R = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = o.method || 'GET';
                    if (m === 'POST' && /\\/api\\/agent-asks\\/7\\/answer$/.test(url)) { window.__posts.push(JSON.parse(o.body)); if (window.__refuse) { window.__refuse = false; return json({ error: 'gone', message: 'that agent is not running' }, 409); } window.__answered = true; return json({ ok: true }); }
                    if (m === 'GET' && /\\/api\\/operator-asks(\\?|$)/.test(url)) { window.__lists++; return json(window.__answered ? [] : [ask]); }
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`/Which database should the notes app use/.test(document.getElementById('group-table-view').innerText)`, `${width}: the agent's question is a row in Needs you`, 15000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'operator_asks.js'); await m.openAskDialog({ board: '', asker: 'claude-4f2a', kind: 'agent', id: 7, at: new Date(Date.now() - 60000).toISOString(), text: 'Which database should the notes app use?' }, undefined, { goal() {}, task() {} }); return true; })()`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog textarea')`, `${width}: the dialog`, 8000);
            const send = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); d.querySelector('.inbox-ask-send').click(); return true; })()`);
            await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog textarea'); b.value = 'SQLite'; b.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await send();
            await waitFor(`window.__posts.length === 1 && /Not sent: that agent is not running/.test(document.querySelector('dialog.inbox-ask-dialog .inbox-ask-error').textContent)`, `${width}: a refusal says so in the server's words`, 8000);
            assert.equal(await ev(`document.querySelector('dialog.inbox-ask-dialog textarea').value`), 'SQLite', `${width}: the typed text stays`);
            assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`), true, `${width}: the dialog stays open after a refusal`);
            await shot('single-agent-answer-refused-' + width);
            const listsBefore = await ev(`window.__lists`);
            await send();
            await waitFor(`window.__posts.length === 2 && !document.querySelector('dialog.inbox-ask-dialog[open]')`, `${width}: the second try is sent and the dialog closes`, 8000);
            assert.deepEqual(await ev(`window.__posts`), [{ answer: 'SQLite' }, { answer: 'SQLite' }], `${width}: the answer is the typed text, both times`);
            await waitFor(`/Reply sent to claude-4f2a/.test(document.body.textContent)`, `${width}: the page says it went`, 5000);
            await waitFor(`window.__lists > ${listsBefore}`, `${width}: the list is read again`, 8000);
            await waitFor(`!/Which database should the notes app use/.test(document.getElementById('group-table-view').innerText)`, `${width}: the row is gone from Needs you`, 8000);
            await shot('single-agent-answer-done-' + width);
        }
        console.log('\nPASS a single agent question is answered from the dialog: refusal kept, answer sent, row closed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
