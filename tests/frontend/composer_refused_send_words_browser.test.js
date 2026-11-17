// A composer send the server refuses says why in plain words, never a bare route answer or a raw error (#19173, the Operator's bug: "an error that gives no reason"). Each refusal below is what a route answers
// today ('session is sleeping', 'live session not found', a raw 500 from a failed terminal write, ...); the sentence under the composer says what happened and what to do, the text is back in the box,
// and none of the raw words show. The server's own sentences (agent_busy, ...) pass through unchanged. The agent and its routes are mocked in the page (agent_view_harness.js). Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

// name -> the refusal the send to it gets: [status, body]
const REFUSALS = {
    'rf-sleep': [409, { error: 'session is sleeping' }],
    'rf-archived': [409, { error: 'session is archived' }],
    'rf-gone': [404, { error: 'live session not found' }],
    'rf-badid': [400, { error: 'invalid session_id' }],
    'rf-raw': [500, { error: 'exit status 1: tmux send-keys: no server running' }],
    'rf-busy': [409, { error: 'Other messages to this agent are still being sent: yours was not sent. Try again in a moment.', code: 'agent_busy', not_sent: true }],
};
const STUB = `(() => {
    const prev = window.fetch, R = ${JSON.stringify(REFUSALS)};
    window.__sends = [];
    const json = (b, status) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    window.fetch = (url, opts = {}) => {
        const m = /\\/api\\/sessions\\/live\\/([^/]+)\\/send$/.exec(String(url));
        if (m && (opts.method || 'GET').toUpperCase() === 'POST') {
            const name = decodeURIComponent(m[1]);
            window.__sends.push(name);
            const r = R[name];
            return Promise.resolve(r ? json(r[1], r[0]) : json({ ok: true }, 200));
        }
        return prev(url, opts);
    };
})()`;

// what must be in the sentence, and what must not be
const EXPECT = {
    'rf-sleep': [/asleep/i, /wake/i, /^(?!.*session is sleeping)/i],
    'rf-archived': [/archived/i, /restore/i, /^(?!.*session is archived)/i],
    'rf-gone': [/no longer find this agent/i, /not sent/i, /^(?!.*live session not found)/i],
    'rf-badid': [/which agent/i, /reload/i, /^(?!.*invalid session_id)/i],
    'rf-raw': [/couldn't type your message/i, /not sent/i, /^(?!.*(exit status|tmux))/i],
    'rf-busy': [/still being sent/i, /not sent/i, /^(?!.*agent_busy)/i],
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const type = text => ev(`(() => { const i = document.getElementById('command-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const failures = [];
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        for (const name of Object.keys(REFUSALS)) {
            await ev(`window.__m.add(${JSON.stringify(name)}, 'A', 2, { sleeping: false, session_id: ${JSON.stringify(name + '-id')} }); true`);
            await select(name);
            await waitFor(`!!document.getElementById('command-input')`, 'the composer');
            await ev(`window.__sends.length = 0; window.clearComposerError && window.clearComposerError(); true`);
            const draft = 'message for ' + name;
            await type(draft);
            await ev(`window.sendCommand(); true`);
            await waitFor(`!!document.querySelector('#composer-error:not([hidden]) .composer-error-text') && document.querySelector('#composer-error .composer-error-text').textContent.trim() !== ''`, name + ': the composer error', 8000);
            const text = await ev(`document.querySelector('#composer-error .composer-error-text').textContent.trim()`);
            for (const re of EXPECT[name]) if (!re.test(text)) failures.push(`${name}: ${re} does not match "${text}"`);
            const back = await ev(`document.getElementById('command-input').value`);
            if (back !== draft) failures.push(`${name}: the text is not back in the box ("${back}")`);
            console.log('  ' + name + ' -> ' + text);
        }
        assert.equal(failures.length, 0, '\n' + failures.join('\n'));
        console.log('PASS a refused send says why in plain words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
