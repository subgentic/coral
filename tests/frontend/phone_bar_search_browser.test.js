// A search field in the phone's top bar on every top-level screen that has a search (#11476, Gmail's "Search in mail"): at 390 px the bar's pill is a field whose placeholder says what it searches (Inbox, Chats, Automations,
// Analytics, Docs); what is typed goes into that view's own search (the sidebar's, hidden on a phone), so the view filters as it does anywhere; each view keeps its own words; a screen with no search (Computers) keeps its title.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        const field = () => ev(`(() => { const i = [...document.querySelectorAll('.phone-bar-search')].find(e => e.getClientRects().length); return i ? { placeholder: i.placeholder, value: i.value, label: i.getAttribute('aria-label'), h: Math.round(i.getBoundingClientRect().height), title: i.closest('.phone-bar-title').textContent } : null; })()`);
        // Inbox
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`[...document.querySelectorAll('.phone-bar-search')].some(e => e.getClientRects().length)`, 'the Inbox has a search in its bar', 8000);
        let f = await field();
        check(f && /^Search /.test(f.placeholder) && f.h >= 44 && f.label === f.placeholder + ' from the top bar', 'the pill is a search field with a name and a 44 px height: ' + JSON.stringify(f));
        await ev(`window.__seen = []; document.getElementById('inbox-search').addEventListener('input', e => window.__seen.push(e.target.value)); [...document.querySelectorAll('.phone-bar-search')].find(e => e.getClientRects().length).focus(); true`);
        await client.Input.insertText({ text: 'abc' });
        await waitFor(`document.getElementById('inbox-search').value === 'abc'`, 'what is typed goes into the Inbox search', 5000);
        check(await ev(`window.__seen.includes('abc')`), 'the view\'s own search heard it as typing');
        // two controls never share a name: the sidebar's own search (display: none on a phone, but still in the page) has its own
        check(await ev(`(() => { const names = [...document.querySelectorAll('input[type=search]')].map(i => i.getAttribute('aria-label')).filter(Boolean); return new Set(names).size === names.length; })()`), 'no two search fields share an accessible name');
        // another view has its own words
        await ev(`window.switchNavTab('automations'); true`);
        await waitFor(`[...document.querySelectorAll('.phone-bar-search')].some(e => e.getClientRects().length && /Automations/.test(e.placeholder))`, 'Automations has its own field', 8000);
        f = await field();
        check(f && f.value === '', 'Automations does not carry the Inbox words: ' + JSON.stringify(f));
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`[...document.querySelectorAll('.phone-bar-search')].some(e => e.getClientRects().length && e.value === 'abc')`, 'the Inbox keeps its words', 8000);
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the phone bar is a search field on a screen that has a search');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
