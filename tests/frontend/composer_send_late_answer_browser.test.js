// A send whose answer came back unusable, though Coral typed the text, is not reported as "unable to send" (#18592):
//   - through the Hub, POST /send can answer a gateway error (504 with an HTML body) or drop the connection after the tunnel's or
//     the Hub's header limit, while the agent already got the text;
//   - the agent's live row lists what Coral typed in the last 90 s (pending_sends); when the text is there, the bubble says Sent,
//     the box and the saved draft are empty and no error shows (a second send would type it twice);
//   - an earlier message with the same words (listed 60 s before this send) is not this one: it is put back;
//   - when the row does not list it, the text still goes back in the box with the error, as before.
// The agent and its send route are mocked in the page (agent_view_harness.js). Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

// POST /send answers as window.__mode says; the agent's row lists window.__typed as pending_sends.
const MOCK = `(() => {
    const prev = window.fetch;
    window.__mode = '504'; window.__typed = []; window.__sends = 0;
    window.fetch = (url, opts = {}) => {
        const u = String(url);
        if (/\\/api\\/sessions\\/live\\/cl-[^/]+\\/send$/.test(u) && (opts.method || 'GET').toUpperCase() === 'POST') {
            window.__sends++;
            if (window.__mode === 'drop') return Promise.reject(new TypeError('Failed to fetch'));
            return Promise.resolve(new Response('<html><body>504 Gateway Time-out</body></html>', { status: 504, headers: { 'content-type': 'text/html' } }));
        }
        return prev(url, opts);
    };
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const type = text => ev(`(() => { const i = document.getElementById('command-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const box = () => ev(`document.getElementById('command-input').value`);
    const draft = () => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'state.js'); return m.state.sessionInputText[m.sessionKey(m.state.currentSession)] || ''; })()`);
    const composerError = () => ev(`(() => { const e = document.getElementById('composer-error'); return e.hidden ? '' : e.textContent; })()`);
    const bubbles = sel => ev(`document.querySelectorAll('#live-history-messages ${sel} .chat-bubble').length`);
    const settle = () => ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: a text put back, if any, would be within this
    const typedIs = (text, ageMs = 0) => ev(`(() => { const e = window.__m.entry.bind(window.__m); window.__m.entry = a => Object.assign(e(a), { pending_sends: ${JSON.stringify(text)} ? [{ id: 'p1', text: ${JSON.stringify(text)}, at: new Date(Date.now() - ${ageMs}).toISOString() }] : [] }); return true; })()`);
    const fresh = async () => {
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('cl-a', 'A', 4, { sleeping: false }); true`);
        await select('cl-a');
        await waitFor(`window.__rendered().length > 0`, 'the conversation');

    };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: MOCK });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        for (const mode of ['504', 'drop']) {
            const text = mode === '504' ? 'deploy to staging' : 'run the tests';
            await fresh();
            console.log(`1. ${mode}: the row lists the text, so it arrived: Sent, box empty, no error`);
            await ev(`window.__mode = ${JSON.stringify(mode)}; true`);
            await typedIs(text);
            await type(text);
            await ev(`window.sendCommand(); true`);
            await waitFor(`window.__sends >= 1`, 'the send request');
            try {
                await waitFor(`[...document.querySelectorAll('#live-history-messages .pending-sent .chat-bubble .message-text')].some(t => t.textContent.trim() === ${JSON.stringify(text)})`, 'the Sent bubble holding the text');
            } catch (e) { console.log('DOM', mode, await ev(`(document.querySelector('#live-history-messages .pending-messages') || document.getElementById('live-history-messages')).outerHTML.slice(0, 1500)`), 'box', await box(), 'err', await composerError()); throw e; }
            await settle();
            assert.equal(await box(), '', 'nothing is put back: sending it again would type it twice');
            assert.equal(await draft(), '');
            assert.equal(await composerError(), '', 'no "unable to send"');
            assert.equal(await bubbles('.pending-failed, .pending-unsent'), 0);
        }

        await fresh();
        console.log('2. the row lists the same words from 60 s before this send: an earlier message, so this one was not typed');
        await ev(`window.__mode = 'drop'; true`);
        // The input can match before sending starts, and is restored before responseError() resolves.
        // Wait for the send outcome before checking the error in these refusal cases.
        await typedIs('ok', 60000);
        await type('ok');
        await ev(`window.sendCommand()`);
        await waitFor(`document.getElementById('command-input').value === 'ok'`, 'the text back in the box');
        assert.notEqual(await composerError(), '', 'the error shows');

        await fresh();
        console.log('3. the row does not list the text: it was not typed, the text goes back with an error');
        await ev(`window.__mode = '504'; true`);
        await typedIs('');
        await type('never arrived');
        await ev(`window.sendCommand()`);
        await waitFor(`document.getElementById('command-input').value === 'never arrived'`, 'the text back in the box');
        assert.notEqual(await composerError(), '', 'the error shows');
        console.log('\nPASS composer send late answer: a send the agent got is Sent; one it did not is put back');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
