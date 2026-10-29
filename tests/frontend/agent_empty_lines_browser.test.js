// The side panel's Notes and Artifacts say plainly what they are when empty (#10055, Desktop #10051, Beta #10105): Notes "Private notes for you about this chat" (gone once there is a note),
// Artifacts "Nothing shared yet. Files this agent shares appear here." Real isolated server, one agent with nothing. 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__m.add('empty-bot', 'A', 3, { sleeping: false }); true`);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers; no single completion event
        await ev(`window.selectLiveSession('empty-bot', 'claude', 'empty-bot-id', 'local'); true`);
        await waitFor(`!!document.getElementById('note-md-rendered')`, 'the notes panel', 8000);
        console.log('1. Notes with no note says what it is for');
        await ev(`window.switchAgenticTab('notes', 'top'); true`);
        await ev(`(async () => { const m = await import(${S} + 'agent_notes.js'); await m.loadAgentNotes('empty-bot', 'empty-bot-id'); return true; })()`);
        await waitFor(`/Private notes for you about this chat/.test(document.getElementById('note-md-rendered').textContent)`, 'the empty Notes line', 5000);
        await shot('notes-empty');
        const posted = await ev(`fetch('/api/sessions/live/empty-bot/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'a first note', session_id: 'empty-bot-id' }) }).then(r => r.status)`);
        assert.equal(posted, 200);
        await ev(`(async () => { const m = await import(${S} + 'agent_notes.js'); await m.loadAgentNotes('empty-bot', 'empty-bot-id'); return true; })()`);
        await waitFor(`document.querySelectorAll('#note-md-rendered .note-card').length === 1`, 'the note', 5000);
        assert.ok(!/Private notes for you/.test(await ev(`document.getElementById('note-md-rendered').textContent`)), 'the line goes once there is a note');
        console.log('2. Artifacts with nothing shared says where files appear');
        await ev(`window.switchAgenticTab('artifacts', 'top'); true`);
        await waitFor(`/Nothing shared yet\\. Files this agent shares appear here\\./.test(document.getElementById('agentic-panel-artifacts-view').textContent)`, 'the empty Artifacts line', 8000);
        await shot('artifacts-empty');
        console.log('PASS Notes and Artifacts are plain when empty');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
