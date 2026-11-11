// A request that can only be rejected (it was cut, holds a hidden character or is not text, #11399) has no Allow anywhere, and the Inbox row is one of those places: it offers no answer at all (#15501, the Operator: not even No), says Coral could not read it in full and that it is answered in the agent's terminal, shows Open agent as the main button, and sends nothing for an Allow even if the card changes under a stale row. The server refuses an Allow too (409
// only_reject); this is the row not offering it. The chat reply and the answer route are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const CLAUDE = ['Yes', 'No'];
const CODEX = ['Yes, proceed (y)', "Yes, and don't ask again for commands that start with `touch` (p)", 'No, and tell Codex what to do differently (esc)'];
const REJECT_ONLY = ['Reject']; // opencode's card
const ALLOW_ONLY = ['Yes', 'Yes, proceed'];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__posts = []; window.__ask = 'ask-1'; window.__opts = ${JSON.stringify(CLAUDE)}; window.__flag = 'none';
            const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__posts.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })); }
                if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) {
                    const po = { question: 'Do you want to proceed?', ask_id: window.__ask, options: window.__opts.map((label, i) => ({ n: i + 1, label, action: 'select' })) };
                    const reply = { messages: [], total: 0, prompt_options: po };
                    if (window.__flag === 'screen') po.only_reject = true;
                    if (window.__flag === 'pending') reply.pending = { tool_use_id: 't1', tool_name: 'bash', input: { command: 'ls', only_reject: true, note: 'This request holds characters that can hide what it does.' } };
                    return Promise.resolve(new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } }));
                }
                return real(u, o); };
            true`);
        let n = 0;
        const draw = async agent => ev(`(async () => { const m = await import(${MOD} + 'inbox_answer.js'); const cell = m.answerCell({ name: '${agent}-x${++n}', session_id: 'sess-${n}', agent_type: '${agent}', waiting_since: 't${n}' }); document.body.append(cell); window.__cell = cell; return true; })()`);
        const labels = () => ev(`[...window.__cell.querySelectorAll('button.inbox-answer')].map(b => b.textContent)`);
        const note = () => ev(`(window.__cell.querySelector('.inbox-only-reject') || {}).textContent || ''`);
        const set = (opts, flag) => ev(`window.__opts = ${JSON.stringify(opts)}; window.__flag = ${JSON.stringify(flag)}; true`);

        // 0. an ordinary request: Yes and No, no note (the row is as before)
        await set(CLAUDE, 'none'); await draw('claude');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 2`, 'the ordinary choices', 5000);
        assert.deepEqual(await labels(), ['Yes', 'No']);
        assert.equal(await note(), '', 'an ordinary row says nothing about rejecting');

        const openBtn = () => ev(`(() => { const b = window.__cell.querySelector('button.inbox-open-agent'); return b ? { text: b.textContent, primary: b.classList.contains('btn-primary') } : null; })()`);
        const unread = async (why) => { // #15501: a request Coral did not read in full has no answer at all, not even the No: it says so and Open agent is the way on
            await waitFor(`/could not read this request in full/i.test(window.__cell.textContent)`, why, 5000);
            assert.deepEqual(await labels(), [], why + ': no answer button, not even No');
            assert.match(await note(), /answer it in the agent.s terminal/i, why + ': says where to answer it');
            assert.deepEqual(await openBtn(), { text: 'Open agent', primary: true }, why + ': Open agent is the main button');
            assert.ok(!/can only be rejected/i.test(await ev(`window.__cell.textContent`)), why + ': the old wording is gone');
        };
        // 1. only_reject on the screen agents' prompt_options
        await set(CLAUDE, 'screen'); await draw('claude'); await unread('screen only_reject');
        // 2. only_reject on the pending tool (Claude, Pi, opencode): the same
        await set(CLAUDE, 'pending'); await draw('claude'); await unread('pending only_reject');
        // 3. Codex's own words: no No, no Yes
        await set(CODEX, 'screen'); await draw('codex'); await unread('codex');
        // 4. opencode's card is Reject alone: still no button
        await set(REJECT_ONLY, 'pending'); await draw('opencode'); await unread('opencode');
        // 5. no Reject form at all: the same
        await set(ALLOW_ONLY, 'screen'); await draw('claude'); await unread('allow only');

        // 7. a stale row: drawn when the request was ordinary (Yes and No), then the request turns out to be Reject-only: a click on Yes sends nothing and says the question changed
        await ev(`window.__posts = []; true`); await set(CLAUDE, 'none'); await draw('claude');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 2`, 'the ordinary row', 5000);
        await set(CLAUDE, 'screen');
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__cell.querySelector('button.inbox-answer').click(); true`); // the first button is Yes
        await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(e => /That question changed; look at it again/.test(e.textContent))`, 'the stale Yes says the question changed', 5000);
        assert.deepEqual(await ev(`window.__posts`), [], 'a stale Yes on a request that turned Reject-only sends nothing');
        // 8. on a phone the words and Open agent fit the row: nothing sideways
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await set(CLAUDE, 'screen'); await draw('claude'); await unread('phone');
        const fit = await ev(`(() => { const c = window.__cell, b = c.querySelector('button.inbox-open-agent').getBoundingClientRect(), n = c.querySelector('.inbox-only-reject').getBoundingClientRect(); return { pageFits: document.documentElement.scrollWidth <= innerWidth, openFits: b.right <= innerWidth && b.left >= 0, noteFits: n.right <= innerWidth + 1 && n.left >= 0, touch: b.height >= 40 }; })()`);
        assert.deepEqual(fit, { pageFits: true, openFits: true, noteFits: true, touch: true }, 'phone: ' + JSON.stringify(fit));
        console.log('PASS Inbox row: a request that can only be rejected has no Allow, has no answer, says so and opens the agent, a stale Yes sends nothing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
