// #10301 (Mobile pass 22, #10298): two people, one Coral. Two phone-sized browsers (two browser contexts: separate storage, as two devices have) look at the same agent, which waits on a question.
//  1. A message queued behind the question belongs to its sender: the other device sees "Queued from another device: ..." with no Cancel, and a cancel or a send by the sender empties both
//     screens at once (the empty list came through the feed as a null that was skipped, so the other screen kept the line).
//  2. A question answered on one device says "Answered "Red" from another device." on the other, and a tap there that finds the question gone is not an error.
// The server is played by this test: it holds the queue and the last answer, and pushes the live row to both pages as the feed does (the Go tests cover the real server side).
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;
const CDP_PORT = Number(process.env.CDP_PORT || 9222);

async function browserClient() {
    const info = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    return CDP({ target: info.webSocketDebuggerUrl });
}

// One device: a browser context of its own, a tab in it, the harness on that tab, the agent selected.
async function device(name) {
    const browser = await browserClient();
    const { browserContextId } = await browser.Target.createBrowserContext();
    const { targetId } = await browser.Target.createTarget({ url: 'about:blank', browserContextId });
    await browser.close();
    const d = await connect({ target: targetId });
    const { Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = d;
    await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await Emulation.setTouchEmulationEnabled({ enabled: true });
    await Page.enable();
    await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
    await Page.navigate({ url: BASE + '/' });
    await Page.loadEventFired();
    await install();
    await ev(`window.__coralReady.then(() => true)`);
    // The server's two answers this test plays: the held message's cancel, and an answer to the question.
    await ev(`(() => {
        window.__calls = []; window.__answerStatus = 200;
        const inner = window.fetch;
        window.fetch = (url, opts = {}) => {
            const u = String(url), method = (opts.method || 'GET').toUpperCase();
            const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            if (/\\/api\\/sessions\\/live\\/dv\\/held\\//.test(u)) { window.__calls.push([method, u.replace(/^https?:\\/\\/[^/]+/, '')]); return json({ ok: true }); }
            if (/\\/api\\/sessions\\/live\\/dv\\/answer-prompt$/.test(u)) {
                window.__calls.push([method, 'answer-prompt']);
                return window.__answerStatus === 200 ? json({ ok: true, answered: 'Red', at: 111 }) : json({ error: 'The prompt is no longer open. Check the terminal.' }, 409);
            }
            return inner(url, opts);
        };
        // The feed's diff of the agent's row, with the fields the server owns here.
        window.__push = patch => { const a = window.__m.agents['dv-id']; T.ws.handleCoralMessage({ type: 'coral_diff', changed: [{ ...window.__m.entry(a), ...patch }] }); };
    })()`);
    await ev(`window.__m.add('dv', 'A', 0, { sleeping: false, agent_type: 'claude', session_id: 'dv-id' }); true`);
    await sleep(500); // sleep-ok: the first live list renders from several answers; no single completion event
    await ev(`window.selectLiveSession('dv', 'claude', 'dv-id', 'local'); true`);
    await waitFor(`!!document.getElementById('composer-queued') && !!window.__qaState.liveSessions.find(s => s.session_id === 'dv-id')`, `${name}: the composer and the agent`, 8000);
    return d;
}

(async () => {
    const A = await device('A'), B = await device('B');
    const S = `(window.__coralStatic || '/static/')`;
    const both = fn => Promise.all([fn(A), fn(B)]);
    // The queue as a device shows it.
    const queue = d => d.ev(`(() => { const b = document.getElementById('composer-queued'); return { items: [...b.querySelectorAll('.composer-queued-item')].map(i => i.querySelector('.composer-queued-text').textContent), cancels: b.querySelectorAll('.composer-queued-cancel').length, note: (b.querySelector('.composer-queued-note') || {}).textContent || '' }; })()`);
    const composerError = d => d.ev(`(() => { const e = document.getElementById('composer-error'); return e && !e.hidden ? e.textContent.trim() : ''; })()`);
    const emit = (d, type, detail) => d.ev(`document.dispatchEvent(new CustomEvent(${JSON.stringify(type)}, { detail: ${JSON.stringify(detail)} })); true`);
    try {
        console.log('1. a queued message belongs to its sender');
        // A sends while the agent waits: the composer remembers the frame, the server answers "held" with its id, and the row lists the message for everyone.
        await A.ev(`Promise.all([import(${S} + 'held_sends.js'), import(${S} + 'terminal_gone.js')]).then(([h, g]) => { h.rememberSend('dv-id', 7, 'Run the tests please'); g.awaitSocketAccept({ session_id: 'dv-id' }, [7]); return true; })`);
        await emit(A, 'coral:terminal-input-held', { sessionId: 'dv-id', id: 7, heldId: 'h1' });
        await both(d => d.ev(`window.__push({ waiting_for_input: true, held_messages: [{ id: 'h1', text: 'Run the tests please' }] })`));
        await A.waitFor(`document.querySelectorAll('#composer-queued .composer-queued-item').length === 1`, 'A: the queued line', 4000);
        await B.waitFor(`document.querySelectorAll('#composer-queued .composer-queued-item').length === 1`, 'B: the queued line', 4000);
        let qa = await queue(A), qb = await queue(B);
        assert.deepEqual(qa.items, ['“Run the tests please”'], 'A sees its own message');
        assert.equal(qa.cancels, 1, 'A can cancel its own message');
        assert.deepEqual(qb.items, ['Queued from another device: “Run the tests please”'], 'B sees whose it is');
        assert.equal(qb.cancels, 0, 'B cannot cancel it');
        console.log('   ✓ the sender has Cancel; the other device says "Queued from another device" and has none');

        // A cancels: the server drops it and the row says so (a null list) to both.
        await A.ev(`document.querySelector('#composer-queued .composer-queued-cancel').click(); true`);
        await A.waitFor(`window.__calls.some(c => c[0] === 'DELETE' && /\\/held\\/h1$/.test(c[1]))`, 'A: the cancel to be asked', 4000);
        await both(d => d.ev(`window.__push({ held_messages: null })`));
        await B.waitFor(`document.querySelectorAll('#composer-queued .composer-queued-item').length === 0`, 'B: the line to go after the cancel', 4000);
        await A.waitFor(`document.querySelectorAll('#composer-queued .composer-queued-item').length === 0`, 'A: the line to go after the cancel', 4000);
        assert.equal(await A.ev(`document.getElementById('command-input').value`), 'Run the tests please', 'A gets the text back');
        assert.equal(await B.ev(`document.getElementById('command-input').value`), '', 'B gets nothing');
        console.log('   ✓ a cancel empties both screens');

        // A sends again; the question is answered and the message is typed: both lines go (A says "Sent.").
        await A.ev(`document.getElementById('command-input').value = ''; true`);
        await A.ev(`Promise.all([import(${S} + 'held_sends.js'), import(${S} + 'terminal_gone.js')]).then(([h, g]) => { h.rememberSend('dv-id', 8, 'Second one'); g.awaitSocketAccept({ session_id: 'dv-id' }, [8]); return true; })`);
        await emit(A, 'coral:terminal-input-held', { sessionId: 'dv-id', id: 8, heldId: 'h2' });
        await both(d => d.ev(`window.__push({ held_messages: [{ id: 'h2', text: 'Second one' }] })`));
        await B.waitFor(`document.querySelectorAll('#composer-queued .composer-queued-item').length === 1`, 'B: the second line', 4000);
        await both(d => d.ev(`window.__push({ held_messages: [{ id: 'h2', text: 'Second one', sending: true }] })`));
        await emit(A, 'coral:terminal-input-ack', { sessionId: 'dv-id', id: 8 });
        await both(d => d.ev(`window.__push({ held_messages: null, waiting_for_input: false })`));
        await B.waitFor(`document.querySelectorAll('#composer-queued .composer-queued-item').length === 0`, 'B: the line to go once typed', 4000);
        await A.waitFor(`document.querySelectorAll('#composer-queued .composer-queued-item').length === 0`, 'A: the line to go once typed', 4000);
        assert.equal((await queue(A)).note, 'Sent.', 'A is told it was sent');
        console.log('   ✓ a send empties both screens');

        // The sender's ownership is kept in this browser (a reload, or another tab of it, still owns what it sent).
        await A.ev(`Promise.all([import(${S} + 'held_sends.js')]).then(([h]) => { h.noteHeld('dv-id', 9, 'Kept across a reload', 'h3'); return true; })`);
        await A.ev(`window.__push({ waiting_for_input: true, held_messages: [{ id: 'h3', text: 'Kept across a reload' }] })`);
        assert.ok(await A.ev(`Object.keys(JSON.parse(localStorage.getItem('coral-held-mine') || '{}')).includes('h3')`), 'the sender remembers what it sent in this browser');

        console.log('2. a question answered on one device');
        await both(d => d.ev(`window.__push({ waiting_for_input: true, held_messages: null })`));
        // A answers; the server records it and the row carries it.
        await A.ev(`import(${S} + 'chat_prompt_empty.js').then(m => m.sendPromptAnswer(null, 1, 'Red', 'select', ''))`);
        assert.ok(await A.ev(`window.__calls.some(c => c[1] === 'answer-prompt')`), 'A answered');
        await both(d => d.ev(`window.__push({ waiting_for_input: false, last_answer: { label: 'Red', at: 111 } })`));
        await B.waitFor(`/Answered “Red” from another device\\./.test(document.getElementById('composer-queued').textContent)`, 'B: the note about the answer', 4000);
        assert.ok(!/another device/.test((await queue(A)).note), 'A, which answered, is not told it did');
        console.log('   ✓ the other device says "Answered “Red” from another device."');

        // B taps an answer a moment later: the server finds the question gone (409). That is said, not shown as an error.
        await both(d => d.ev(`window.__push({ waiting_for_input: true, last_answer: null })`));
        await B.ev(`window.__answerStatus = 409; true`);
        await both(d => d.ev(`window.__push({ waiting_for_input: false, last_answer: { label: 'Blue', at: 222 } })`));
        await B.ev(`import(${S} + 'chat_prompt_empty.js').then(m => m.sendPromptAnswer(null, 2, 'Green', 'select', ''))`);
        assert.equal(await composerError(B), '', 'B: no error under the box');
        assert.match((await queue(B)).note, /Answered “Blue” from another device\./);
        console.log('   ✓ a tap on a question another device answered is not an error');
        console.log('\nAll two-device checks passed');
    } finally {
        await A.client.close(); await B.client.close();
    }
})().catch(err => { console.error(err); process.exit(1); });
