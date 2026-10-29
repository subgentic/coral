// How do I...? answers three more questions (#10765): continue an old chat, give an agent a file, what the permission modes allow. The Docs search finds each (How do I...? first, the page opens at the
// sentence), and Settings' Learn more beside Default permission mode is a link that opens the last answer in Docs, at its heading, not a box behind Settings. Against the real docs of the isolated dev
// server, 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);
        const search = async q => { await ev(`(() => { const i = document.getElementById('docs-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await sleep(300); }; // sleep-ok: the search waits for the topics' text
        const settled = async () => { await waitFor(`!/Searching the topics/.test(document.getElementById('docs-nav-list').textContent)`, 'the search settled', 20000); await sleep(300); }; // sleep-ok: the list is redrawn after the text arrives

        for (const [q, heading, words] of [['continue an old chat', 'Continue an old chat', /continue|resume|chat/i], ['give an agent a file', 'Give an agent a file', /file|@|picture/i], ['permission modes allow', 'What the permission modes allow', /permission|mode/i]]) {
            await search(q); await settled();
            const hits = await ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].map(b => b.dataset.doc)`);
            assert.equal(hits[0], 'how-do-i', `${q}: How do I...? is first: ${JSON.stringify(hits.slice(0, 4))}`);
            await ev(`document.querySelector('#docs-nav-list [data-doc="how-do-i"]').click(); true`);
            await waitFor(`!!document.querySelector('#docs-content .doc-hit')`, `${q}: the page opens at the sentence`, 8000);
            const at = await ev(`(() => { const e = document.querySelector('#docs-content .doc-hit'); return { text: e.textContent.trim().slice(0, 160), has: [...document.querySelectorAll('#docs-content h2')].some(h => h.textContent.trim() === ${JSON.stringify(heading)}) }; })()`);
            assert.ok(at.has, `${q}: the answer "${heading}" is in the topic`);
            assert.match(at.text, words, `${q}: the marked sentence has the words: ${at.text}`);
        }

        // Settings' Learn more beside Default permission mode opens the answer in Docs, at its heading
        await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import((window.__coralStatic || '/static/') + 'modals.js'); }).then(m => m.showSettingsModal('agents')).then(() => true)`);
        await waitFor(`!!document.getElementById('settings-permission-mode') && document.getElementById('settings-permission-mode').getClientRects().length > 0`, 'the permission row', 10000);
        const link = await ev(`(() => { const a = document.getElementById('settings-permission-mode').closest('.sv-row').querySelector('a.sv-learn'); return a && { href: a.getAttribute('href'), label: a.getAttribute('aria-label') }; })()`);
        assert.deepEqual(link, { href: '/docs/how-do-i', label: 'Learn more about Default permission mode, in Docs' }, 'Learn more is a link into Docs');
        await ev(`document.getElementById('settings-permission-mode').closest('.sv-row').querySelector('a.sv-learn').click(); true`);
        await waitFor(`location.pathname === '/docs/how-do-i' && [...document.querySelectorAll('#docs-content h2')].some(h => h.textContent.trim() === 'What the permission modes allow')`, 'the answer opens in Docs', 12000);
        const inView = await ev(`(() => { const h = [...document.querySelectorAll('#docs-content h2')].find(e => e.textContent.trim() === 'What the permission modes allow'), r = h.getBoundingClientRect(), box = document.getElementById('docs-content').getBoundingClientRect(); return r.top >= box.top - 2 && r.top < box.bottom; })()`);
        assert.ok(inView, 'the page is scrolled to the answer\'s heading');
        console.log('PASS How do I...? answers three more questions; Settings\' Learn more opens the permission answer in Docs');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
