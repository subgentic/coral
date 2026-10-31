// The question card's image code loads when a card that can take an answer in words shows, not at start (#11403, start weight): card_attach.js is not fetched with the page, not for a card of buttons alone, and is for the first
// card with "Type something" (which then has its image strip and button as before). The module is the lazy one a request shows: its own file.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const fetched = () => ev(`performance.getEntriesByType('resource').some(r => /\\/card_attach(\\.[0-9a-f]+)?\\.js/.test(r.name))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.equal(await fetched(), false, 'card_attach.js is not fetched with the page');
        const draw = (options, tag) => ev(`(async () => { const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state; const sid = 'la-' + ${JSON.stringify(tag)};
            const row = { session_id: sid, name: 'work', agent_type: 'claude', waiting_for_input: true, waiting_summary: 'Wants to know: Pick' }; st.liveSessions = [row];
            NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear(); NI.loginBySession.clear();
            NI.promptOptionsBySession.set(sid, { question: 'Pick a color:', options: ${JSON.stringify(options)} });
            document.getElementById('la-box')?.remove(); const box = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'la-box', className: 'chat-messages chat-prose' }));
            NI.syncNeedsInputCard(box, row); const c = box.querySelector('.chat-needs-input'); return { card: !!c, strip: !!(c && c.querySelector('.cni-attach')), button: !!(c && c.querySelector('.cni-attach-btn')) }; })()`);
        let r = await draw([{ n: 1, label: 'Red', action: 'select', selected: true }, { n: 2, label: 'Blue', action: 'select' }], 'buttons');
        assert.ok(r.card && !r.strip, 'a card of buttons has no image strip: ' + JSON.stringify(r));
        await new Promise(res => setTimeout(res, 400)); // sleep-ok: a module that was going to load would have started
        assert.equal(await fetched(), false, 'a card of buttons does not load it');
        r = await draw([{ n: 1, label: 'Red', action: 'select', selected: true }, { n: 2, label: 'Type something.', action: 'text' }], 'text');
        assert.ok(r.card && r.strip && r.button, 'a card with a text option has its image strip and button: ' + JSON.stringify(r));
        await waitFor(`performance.getEntriesByType('resource').some(r => /\\/card_attach(\\.[0-9a-f]+)?\\.js/.test(r.name))`, 'the first card with a text option loads card_attach.js', 8000);
        // and it works once loaded: the images' words are what the answer starts with (an empty list says nothing)
        const lead = await ev(`import(${S} + 'card_attach.js').then(m => JSON.stringify(m.answerLead('la-text')))`);
        assert.equal(lead, '[]', 'the module answers: no images, no lead');
        console.log('PASS the question card image code loads with the first text-option card');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
