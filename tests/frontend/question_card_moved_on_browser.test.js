// #14340 (the Operator, phone through the Hub): a QUESTION card stayed at the bottom of an agent's chat after the agent had gone on in the terminal and posted messages AFTER it. A blocked agent says nothing new, so the card
// leaves when the row's last_message is an assistant message written more than 3 s after the question was raised (the row's waiting_since, or the pending AskUserQuestion's start). It stays for a message from before,
// within 3 s, or from the person. 1280 and 390 px; the chat reply and the row are stood in (the card's state is the page's: pending tool, prompt options, the live row).
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const T0 = Date.parse('2026-11-07T11:50:00Z');
    const iso = ms => new Date(T0 + ms).toISOString();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => {
                const inner = window.__innerFetch || (window.__innerFetch = window.fetch);
                window.__pending = null;
                window.fetch = (url, opts = {}) => {
                    if (/\\/api\\/sessions\\/live\\/ask-q[^/?]*\\/chat\\?/.test(String(url))) return inner(url, opts).then(async r => { const d = await r.clone().json().catch(() => null); if (!d) return r;
                        d.pending = window.__pending || null; return new Response(JSON.stringify(d), { status: r.status, headers: { 'content-type': 'application/json' } }); });
                    return inner(url, opts);
                };
                return true; })()`);
            await ev(`window.__m.add('ask-q', 'Q', 0, { sleeping: false, agent_type: 'claude' }); true`);
            await sleep(600); // sleep-ok: the first live list renders from several answers; no single completion event
            const setRow = (patch, pending) => ev(`window.__pending = ${JSON.stringify(pending || null)}; import(${S} + 'state.js').then(st => { const row = st.state.liveSessions.find(s => s.session_id === 'ask-q-id' || s.name === 'ask-q'); Object.assign(row, ${JSON.stringify(patch)}); return import(${S} + 'needs_input_card.js'); }).then(m => { m.refreshNeedsInputCard(); return true; })`);
            const card = () => ev(`(() => { const c = document.querySelector('#live-history-messages .chat-needs-input'); return c ? c.querySelector('.cni-kicker').textContent : null; })()`);
            const ASK = { waiting_for_input: true, waiting_kind: 'question', waiting_summary: 'Wants to know: Which fix do you want?', waiting_since: iso(0), last_message: { role: 'assistant', text: 'I will ask you something', at: iso(-5000) } };
            await setRow(ASK, { tool_name: 'AskUserQuestion', input: {}, at: iso(0) });
            await ev(`window.selectLiveSession('ask-q', 'claude', 'ask-q-id', 'local'); true`);
            await waitFor(`!!document.querySelector('#live-history-messages .chat-needs-input .cni-kicker')`, `${tag}: the Question card`, 8000);
            check(`${tag}: the card is a Question`, /Question/.test(await card()), await card());
            // a message from BEFORE the question, one 2 s after (the same turn's tail) and one from the person: the card stays
            for (const [what, lm] of [['before the question', { role: 'assistant', text: 'earlier', at: iso(-60000) }], ['2 s after it (under the margin)', { role: 'assistant', text: 'tail', at: iso(2000) }], ['from the person, 30 s after', { role: 'user', text: 'hello', at: iso(30000) }]]) {
                await setRow({ ...ASK, last_message: lm }, { tool_name: 'AskUserQuestion', input: {}, at: iso(0) });
                await sleep(200); // sleep-ok: the card redraws
                check(`${tag}: the card stays for a message ${what}`, /Question/.test(String(await card())), String(await card()));
            }
            // the agent said something 20 s after the question: it went on, the card leaves (by the row's time, and by the pending tool's alone)
            await setRow({ ...ASK, last_message: { role: 'assistant', text: 'Moving on without it', at: iso(20000) } }, { tool_name: 'AskUserQuestion', input: {}, at: iso(0) });
            await waitFor(`!document.querySelector('#live-history-messages .chat-needs-input')`, `${tag}: the card leaves when the agent has gone on (row and pending tool)`, 6000);
            check(`${tag}: no card after the agent went on`, (await card()) === null);
            await setRow({ ...ASK, last_message: { role: 'assistant', text: 'again', at: iso(-1000) } }, { tool_name: 'AskUserQuestion', input: {}, at: iso(0) });
            await waitFor(`!!document.querySelector('#live-history-messages .chat-needs-input')`, `${tag}: a new question shows its card again`, 6000);
            await setRow({ waiting_since: null, last_message: { role: 'assistant', text: 'Moving on', at: iso(25000) } }, { tool_name: 'AskUserQuestion', input: {}, at: iso(0) });
            await waitFor(`!document.querySelector('#live-history-messages .chat-needs-input')`, `${tag}: the pending tool's own start is enough to tell it went on`, 6000);
            check(`${tag}: and the card is gone`, (await card()) === null);
        }
    } finally { /* the harness closes the browser */ }
    const failed = results.filter(r => !r).length;
    console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
