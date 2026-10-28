// An agent's standing instructions are shown where the agent is (#10285, Desktop pass 24 #10280): the empty chat's opening text has one line "Instructions: ..." cut at one line with an Edit button that opens the Edit
// instructions dialog, and the row's hover card has an Instructions line. An agent with none shows neither; a terminal never does. The mocked live list carries the agent's prompt. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const LONG = 'Review only; never push to main. ' + 'Explain every change in plain words so a newcomer can follow it. '.repeat(5);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__m.add('with-instr', 'x', 0, { sleeping: false }); window.__m.add('no-instr', 'y', 0, { sleeping: false });` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const r = window.T.state.liveSessions.find(s => s.name === 'with-instr'); r.prompt = ${JSON.stringify(LONG)}; return !!r; })()`);

        console.log('1. the empty chat shows the instructions on one line, with Edit');
        await select('with-instr');
        await waitFor(`!!document.querySelector('.chat-standing:not([hidden])')`, 'the instructions line', 8000);
        const line = await ev(`(() => { const l = document.querySelector('.chat-standing'), t = l.querySelector('.chat-standing-text'); return { text: t.textContent, oneLine: t.getBoundingClientRect().height < 32, btn: l.querySelector('button').textContent.trim() }; })()`);
        assert.match(line.text, /^Instructions: Review only; never push to main\./, line.text); assert.ok(line.text.endsWith('…') && line.text.length <= 160, 'cut with an ellipsis: ' + line.text.length);
        assert.ok(line.oneLine, 'one line'); assert.equal(line.btn, 'Edit');
        await ev(`document.querySelector('.chat-standing button').click(); true`);
        await waitFor(`!!document.getElementById('instructions-dialog') && document.getElementById('instructions-dialog').open`, 'the Edit instructions dialog', 6000);
        assert.ok((await ev(`document.getElementById('instructions-text').value`)).startsWith('Review only; never push to main.'), 'it holds the saved text');
        await ev(`document.getElementById('instructions-dialog').close(); true`);

        console.log('2. an agent with none shows no line');
        await select('no-instr');
        await waitFor(`!!document.querySelector('.chat-empty')`, 'the empty chat', 8000);
        assert.equal(await ev(`(() => { const l = document.querySelector('.chat-standing'); return !l || l.hidden; })()`), true, 'hidden with no instructions');

        console.log('3. the row hover card has an Instructions line');
        const tip = await ev(`import((window.__coralStatic || '/static/') + 'session_state.js').then(m => { const r = window.T.state.liveSessions.find(s => s.name === 'with-instr'); const d = document.createElement('div'); d.innerHTML = m.buildSessionTooltip(r); return [...d.querySelectorAll('.fact-label, dt')].map(e => e.textContent.trim()).concat([d.textContent]); })`);
        assert.ok(tip.includes('Instructions') || /Instructions/.test(tip.join(' ')), 'the hover card says Instructions: ' + JSON.stringify(tip).slice(0, 200));
        const none = await ev(`import((window.__coralStatic || '/static/') + 'session_state.js').then(m => /Instructions/.test(m.buildSessionTooltip(window.T.state.liveSessions.find(s => s.name === 'no-instr'))))`);
        assert.equal(none, false, 'no Instructions line with none');
        console.log('PASS the instructions are shown in the empty chat and the hover card');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
