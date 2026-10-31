// A request that can only be rejected (it was cut, holds a hidden character or is not text, #11399) has no Allow anywhere, and the Inbox row is one of those places: it offers the Reject form of the card's
// answers only (No, Reject, Deny, Cancel), says in words that it can only be rejected here, and sends nothing for an Allow even if the card changes under a stale row. The server refuses an Allow too (409
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

        // 1. only_reject on the screen agents' prompt_options: the No alone, and the words
        await set(CLAUDE, 'screen'); await draw('claude');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 1`, 'only the No', 5000);
        assert.deepEqual(await labels(), ['No'], 'no Yes on a row that can only be rejected');
        assert.match(await note(), /can only be rejected/i);
        assert.match(await note(), /open/i, 'and says where to read it');

        // 2. only_reject on the pending tool (Claude, Pi, opencode): the same
        await set(CLAUDE, 'pending'); await draw('claude');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 1`, 'only the No (pending)', 5000);
        assert.deepEqual(await labels(), ['No']);
        assert.match(await note(), /can only be rejected/i);

        // 3. Codex's own words: the one No, not the "don't ask again" Yes nor the proceed
        await set(CODEX, 'screen'); await draw('codex');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 1`, 'only the No (codex)', 5000);
        assert.deepEqual(await labels(), ['No, and tell Codex what to do differently (esc)']);

        // 4. opencode's card is already Reject alone
        await set(REJECT_ONLY, 'pending'); await draw('opencode');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 1`, 'Reject (opencode)', 5000);
        assert.deepEqual(await labels(), ['Reject']);

        // 5. no Reject form at all: no buttons, but the words are there and Open stays
        await set(ALLOW_ONLY, 'screen'); await draw('claude');
        await waitFor(`/can only be rejected/i.test(window.__cell.textContent)`, 'the words without any button', 5000);
        assert.deepEqual(await labels(), [], 'an Allow is never a button on such a row');

        // 6. the No is sent, with the ask id
        await ev(`window.__posts = []; true`); await set(CLAUDE, 'screen'); await draw('claude');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 1`, 'the No again', 5000);
        await ev(`window.__cell.querySelector('button.inbox-answer').click(); true`);
        await waitFor(`window.__posts.length === 1`, 'the No is sent', 5000);
        assert.equal(await ev(`window.__posts[0].label`), 'No');
        assert.equal(await ev(`window.__posts[0].ask_id`), 'ask-1');

        // 7. a stale row: drawn when the request was ordinary (Yes and No), then the request turns out to be Reject-only: a click on Yes sends nothing and says the question changed
        await ev(`window.__posts = []; true`); await set(CLAUDE, 'none'); await draw('claude');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 2`, 'the ordinary row', 5000);
        await set(CLAUDE, 'screen');
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__cell.querySelector('button.inbox-answer').click(); true`); // the first button is Yes
        await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(e => /That question changed; look at it again/.test(e.textContent))`, 'the stale Yes says the question changed', 5000);
        assert.deepEqual(await ev(`window.__posts`), [], 'a stale Yes on a request that turned Reject-only sends nothing');
        // 8. on a phone the No and the words fit the row: nothing sideways
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await set(CLAUDE, 'screen'); await draw('claude');
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 1`, 'the No on a phone', 5000);
        const fit = await ev(`(() => { const c = window.__cell, b = c.querySelector('button.inbox-answer').getBoundingClientRect(), n = c.querySelector('.inbox-only-reject').getBoundingClientRect(); return { pageFits: document.documentElement.scrollWidth <= innerWidth, noFits: b.right <= innerWidth && b.left >= 0, noteFits: n.right <= innerWidth + 1 && n.left >= 0, touch: b.height >= 40 }; })()`);
        assert.deepEqual(fit, { pageFits: true, noFits: true, noteFits: true, touch: true }, 'phone: ' + JSON.stringify(fit));
        console.log('PASS Inbox row: a request that can only be rejected has no Allow, offers the No form and says so, a stale Yes sends nothing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
