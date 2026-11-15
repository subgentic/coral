// #18106: a single agent's question (no team) opens in the Operator's ask dialog, and its reply goes to POST /api/agent-asks/<id>/answer as {answer},
// not to a board. The send is stood in (fetch). CORAL_SCREENSHOT_DIR saves a shot of the dialog.
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
            await ev(`window.__posts = []; (() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = String(u); if ((o.method || 'GET') === 'POST' && /\\/api\\/agent-asks\\/[^/]+\\/answer$/.test(url)) { window.__posts.push({ url, body: JSON.parse(o.body) }); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return R(u, o); }; })(); true`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'operator_asks.js'); await m.openAskDialog({ board: '', asker: 'claude-4f2a', kind: 'agent', id: 7, at: new Date(Date.now() - 60000).toISOString(), text: 'Which database should the notes app use?\\n\\nChoices:\\n- Postgres\\n- SQLite' }, undefined, { goal() {}, task() {} }); return true; })()`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog textarea')`, `${width}: the question card`, 8000);
            await shot('single-agent-question-' + width);
            await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog textarea'); b.value = 'SQLite'; b.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); const s = [...d.querySelectorAll('button')].find(x => /send reply/i.test(x.textContent)); s.click(); return true; })()`);
            await waitFor(`window.__posts.length === 1`, `${width}: the answer is posted`, 8000);
            assert.equal(await ev(`window.__posts[0].url.endsWith('/api/agent-asks/7/answer')`), true, `${width}: to the agent-ask route`);
            assert.equal(await ev(`window.__posts[0].body.answer`), 'SQLite', `${width}: the answer text`);
        }
        console.log('\nPASS a single agent question is answered through /api/agent-asks');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
