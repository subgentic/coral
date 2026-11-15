// Linked asks show each asker's own words (#17882): two agents' questions that share a key (post --same-as) are one row, and the opened question lists, as written, the other asker's words and buttons
// when they differ from the first's, so the Operator never answers 'may I delete X?' believing it is 'which database?'. A linked ask in the very same words and buttons adds nothing.
// 1280 px; the asks are stubbed in the page, as in ask_dialog_dismiss_browser; a real isolated server serves the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        const at = n => new Date(Date.now() - n * 60000).toISOString();
        const base = { board: 'team', board_label: 'Sprout', kind: 'ask', key: 7 };
        await ev(`(() => { window.__asks = ${JSON.stringify([
            { ...base, id: 42, asker: 'Dev', text: '@Operator which database do we use?', at: at(30) },
            { ...base, id: 43, asker: 'QA', text: '@Operator may I delete the production table?', buttons: [{ id: 1, message_id: 43, pos: 0, label: 'Delete it', action: 'reply', state: 'open' }], at: at(20) },
            { ...base, id: 44, asker: 'Ops', text: '@Operator  which DATABASE do we use?', at: at(10) },
        ])};
            const orig = window.fetch.bind(window);
            window.fetch = (u, o) => { const url = String(u); if (url === '/api/operator-asks') return Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })); return orig(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, 'the linked asks are one row', 10000);
        await ev(`document.querySelector('button[aria-label="Answer the question of Dev"]').click(); true`);
        await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, 'the dialog opens', 4000);
        const o = await ev(`(() => { const s = document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-others'); return s ? { text: s.textContent, ps: [...s.querySelectorAll('p')].map(p => p.textContent) } : null; })()`);
        check('the other words are listed', !!o, JSON.stringify(o));
        check('QA\'s own words and button are shown', !!o && o.ps.length === 1 && /^QA: @Operator may I delete the production table\? \(buttons: Delete it\)$/.test(o.ps[0]), JSON.stringify(o));
        check('the same words (spacing and case aside) add nothing', !!o && !/Ops/.test(o.text), JSON.stringify(o));
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('ask_linked_words_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
