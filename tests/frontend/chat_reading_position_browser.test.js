// The chat's text does not jump (#10846, the operator: "a lot of jumping of the text up and down"). Pinned at the bottom, the chat stays at the bottom when the Working row appears, grows its "Still working" line (30 s),
// a message arrives and the row goes: it was left 36 px short when the row appeared and moved 63 px (88 on a phone) at 30 s and again when the row went. Scrolled up, the message being read moves no more than 2 px while
// messages (text, tool calls, a code block) arrive, the Working row comes, grows and goes, an image loads late, a block changes height, and the needs-input card comes and goes. Pinned, also: a message is Sending, Sent and lands. 1280 and 390 px, a real chat page (the agent's transcript is served by an in-page mock).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const C = `document.getElementById('live-history-messages')`;
    const frames = framesJs(2); // bounded: a hidden page falls back to a timeout
    const problems = [];
    const MSGS = {
        text: k => ({ type: 'assistant', text: 'new reply ' + k + ' ' + 'lorem ipsum '.repeat(30) }),
        tool: k => ({ type: 'tool_use', name: 'Bash', input: { command: 'ls ' + k } }),
        code: k => ({ type: 'assistant', text: 'Here:\n```js\n' + 'const x = 1;\n'.repeat(12) + '```' }),
    };
    const add = (kind, n) => ev(`(async () => { const a = window.__m.agents['jl-id']; const mk = ${MSGS[kind].toString()}; for (let i = 0; i < ${n}; i++) a.msgs.push(mk(a.msgs.length));
        await (await import(${S} + 'live_chat.js')).refreshLiveHistory(); await ${frames}; return true; })()`);
    const setWorking = on => ev(`(async () => { const m = await import(${S} + 'pending_messages.js'); const sid = T.state.currentSession.session_id; T.state.liveSessions = [{ session_id: sid, name: 'jl', working: ${on}, agent_type: 'claude' }]; m.syncWorkingIndicator(${C}, T.state.currentSession); await ${frames}; return true; })()`);
    const still = () => ev(`(async () => { const m = await import(${S} + 'pending_messages.js'); const el = ${C}.querySelector(':scope > .chat-working'); const t0 = Number(el.dataset.since); const real = Date.now; Date.now = () => t0 + 31000; m.tickWorking(el); Date.now = real; await ${frames}; return true; })()`);
    const dist = () => ev(`Math.round(${C}.scrollHeight - ${C}.scrollTop - ${C}.clientHeight)`);
    const scrollToDist = d => ev(`(async () => { const c = ${C}; c.scrollTop = c.scrollHeight - c.clientHeight - ${d}; c.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 250)); return true; })()`); // sleep-ok: the scroll handlers run
    const stamp = () => ev(`(() => { const c = ${C}, cr = c.getBoundingClientRect(); c.querySelectorAll('[data-qa]').forEach(e => delete e.dataset.qa); const el = [...c.querySelectorAll('.chat-bubble')].find(e => e.getBoundingClientRect().top > cr.top + 40 && e.getBoundingClientRect().top < cr.bottom - 40); el.dataset.qa = 'A'; return Math.round(el.getBoundingClientRect().top - cr.top); })()`);
    const off = () => ev(`(() => { const c = ${C}, e = c.querySelector('[data-qa="A"]'); return e ? Math.round(e.getBoundingClientRect().top - c.getBoundingClientRect().top) : null; })()`);
    const SVG = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'><rect width='600' height='400' fill='%23888'/></svg>`;
    const lateImage = () => ev(`(async () => { const b = [...${C}.querySelectorAll('.chat-bubble')].pop(); const img = new Image(); img.style.maxWidth = '100%'; b.appendChild(img); await new Promise(res => { img.onload = res; img.onerror = res; img.src = ${JSON.stringify(SVG)}; }); await ${frames}; return true; })()`);
    const lateCode = () => ev(`(async () => { const pre = [...${C}.querySelectorAll('pre')].pop(); pre.style.padding = '48px 12px'; await ${frames}; return true; })()`); // what a highlighter that arrives late does to a block's height
    const sendMessage = text => ev(`(async () => { const i = document.getElementById('command-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); window.sendCommand(); await ${frames}; return true; })()`);
    const settleSent = () => ev(`(async () => { await new Promise(r => setTimeout(r, 400)); await ${frames}; return true; })()`); // sleep-ok: the mock's send answers after 300 ms
    const needsInput = on => ev(`(async () => { const m = await import(${S} + 'needs_input_card.js'); const st = T.state; const row = st.liveSessions.find(x => x.session_id === st.currentSession.session_id) || (st.liveSessions[0] = { session_id: st.currentSession.session_id, name: 'jl', agent_type: 'claude' }); Object.assign(row, { waiting_for_input: ${on}, waiting_summary: ${on} ? 'Notification: Claude is asking' : null }); m.syncNeedsInputCard(${C}, st.currentSession); await ${frames}; return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const prev = window.fetch; window.fetch = (u, o = {}) => /\\/api\\/sessions\\/live\\/jl\\/send$/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'POST' ? new Promise(r => setTimeout(() => r(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })), 300)) : prev(u, o); })();` });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('jl', 'jl', 150, { sleeping: false }); true`);
            await ev(`window.selectLiveSession('jl', 'claude', 'jl-id', 'local'); true`);
            await waitFor(`${C}.scrollHeight > ${C}.clientHeight * 3 && ${C}.scrollHeight - ${C}.scrollTop - ${C}.clientHeight < 50`, at + 'the chat at the bottom', 8000);

            // pinned at the bottom: it stays there through every change of the tail
            await scrollToDist(0);
            const pinned = async (what, fn) => { await fn(); const d = await dist(); if (d > 2) problems.push(`${at}pinned, ${what}: ${d} px short of the bottom`); };
            await pinned('a message arrives', () => add('text', 1));
            await setWorking(true); await pinned('the Working row appears', async () => {});
            await still(); await pinned('the "Still working" line shows (30 s)', async () => {});
            await pinned('a tool call arrives', () => add('tool', 2));
            await pinned('a code block arrives', () => add('code', 1));
            await setWorking(false); await pinned('the Working row goes', async () => {});
            await add('code', 1); await pinned('a late-loading image arrives', lateImage);
            await pinned('a code block changes height after it is drawn', lateCode);
            await sendMessage('a message from the reader'); await pinned('a message is Sending', async () => {});
            await settleSent(); await pinned('the message is Sent', async () => {});
            await add('text', 1); await pinned('the Sent message lands in the transcript', async () => {});
            await needsInput(true); await pinned('the needs-input card appears', async () => {});
            await needsInput(false); await pinned('the needs-input card goes', async () => {});

            // scrolled up: the message being read stays where it is
            await scrollToDist(450);
            const a0 = await stamp();
            const held = async what => { const o = await off(); if (o === null || Math.abs(o - a0) > 2) problems.push(`${at}reading, ${what}: the message being read moved ${o === null ? '(gone)' : o - a0} px`); };
            await add('text', 2); await held('messages arrive');
            await add('tool', 3); await held('tool calls arrive');
            await add('code', 1); await held('a code block arrives');
            await setWorking(true); await held('the Working row appears');
            await still(); await held('the "Still working" line shows');
            await setWorking(false); await held('the Working row goes');
            await lateImage(); await held('a late-loading image arrives');
            await lateCode(); await held('a code block changes height after it is drawn');
            // (sending a message takes the chat to the bottom on purpose, so there is no reading case for Sending and Sent)
            await needsInput(true); await held('the needs-input card appears');
            await needsInput(false); await held('the needs-input card goes');
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the chat jumped:\n  ' + problems.join('\n  '));
    console.log('PASS the chat holds its position: pinned stays at the bottom, a reader keeps their place');
})().catch(e => { console.error(e); process.exit(1); });
