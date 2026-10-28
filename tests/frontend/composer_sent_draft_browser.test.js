// A message that was sent is not a draft any more (#10085 point 2, Desktop tester #10082): the box is emptied at the send, and so is the saved draft, so a reload before the agent answers does not bring the sent text back
// to be sent twice. A send the server refuses puts the text back in the box and in the saved draft. 1280 px, a mocked agent; the send's answer is held (a message the agent has not taken yet).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const STUB = `(() => { const real = window.fetch; window.__sends = [];
    window.fetch = (u, o = {}) => { if (/\\/api\\/sessions\\/live\\/[^/]+\\/send$/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'POST') { window.__sends.push(JSON.parse(o.body).command); if (window.__refuse) return Promise.resolve(new Response(JSON.stringify({ error: 'refused' }), { status: 409, headers: { 'content-type': 'application/json' } })); return new Promise(() => {}); }
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a frame for the page to act; there is no completion event
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        const open = async () => {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await ev(STUB);
            await ev(`window.__m.add('ak', 'A', 6, { sleeping: false, session_id: 'ak-sid' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
            await select('ak');
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, 'the chat', 15000);
        };
        const typeIt = text => ev(`{ const i = document.getElementById('command-input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        const drafts = () => ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => Object.values(m.state.sessionInputText))`);
        const box = () => ev(`document.getElementById('command-input').value`);
        const send = () => ev(`document.querySelector('#command-pane .btn-send').click(); true`);
        await open();
        await typeIt('please run the tests');
        assert.deepEqual(await drafts(), ['please run the tests'], 'typing saves a draft');
        await send(); await sleep(400); // sleep-ok: the send runs; its answer is held
        assert.equal(await box(), '', 'the box is empty after the send');
        assert.deepEqual(await drafts(), [], 'and so is the saved draft: nothing to come back');
        // a reload before the agent answered
        await open();
        assert.equal(await box(), '', 'after a reload the box is empty: the sent text did not come back');
        assert.deepEqual(await drafts(), [], 'and no draft');
        // a refused send puts the text back, in the box and in the draft
        await ev(`window.__refuse = true; true`);
        await typeIt('second try');
        await send(); await sleep(600); // sleep-ok: the refusal comes back and the text is put back
        assert.equal(await box(), 'second try', 'a refused send puts the text back in the box');
        assert.deepEqual(await drafts(), ['second try'], 'and in the saved draft');
        console.log('\nPASS a sent message does not come back as a draft; a refused one does');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
