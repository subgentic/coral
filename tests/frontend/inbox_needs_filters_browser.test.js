// The Inbox's Needs you (#10399, Beta #10394): (1) a filter that hides waiting items says so, "1 hidden by the Question filter. Show all", Show all clears it, and the pill is back on All when the person
// leaves the Inbox and comes back; (2) on a phone, where a row is one line, each row names its team when two or more teams have something waiting. Two stand-in agents waiting, on two teams, one with a
// permission and one with a question; the live list is fed by a coral_update. 1280 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'settings');
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`);
            await ev(`(async () => { window.__m.agents = {}; window.__m.add('perm-bot', 'A', 1, { sleeping: false, board_project: 'alpha-team' }); window.__m.add('ask-bot', 'B', 1, { sleeping: false, board_project: 'beta-team' }); const ws = await import(${S} + 'websocket.js'); const { state } = await import(${S} + 'state.js'); if (state.coralWs) { state.coralWs.onclose = null; state.coralWs.onmessage = null; try { state.coralWs.close(); } catch {} }
                const sessions = Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), waiting_for_input: true, waiting_kind: /perm/.test(a.name) ? 'permission' : 'question', waiting_summary: /perm/.test(a.name) ? 'Wants to use Bash' : 'Wants to know: Pick a color', waiting_since: new Date(Date.now() - 60000).toISOString() }));
                ws.handleCoralMessage({ type: 'coral_update', servers: [], sessions }); return true; })()`);
            const openNeeds = async () => { await ev(`window.switchNavTab('hub-inbox'); true`); await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await waitFor(`document.getElementById('group-table-view') && document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view tbody tr:not(.dt-group), #group-table-view .dt-mail-row, #group-table-view [data-row-key]').length >= 2`, `${w}: the two waiting agents`, 10000); };
            await openNeeds();
            { // #19919 (MUST-8, the approved mock): a search that matches nothing while Getting started rows remain shows the same card (line, hint, Show all) above them, not a bare '4 hidden by the filters' line
                await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.settings = { ...state.settings, inbox_welcome: 'on' }; return true; })()`);
                await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await settle(500);
                await ev(`(() => { const i = document.getElementById('inbox-search'); i.value = 'zzz-no-such-item'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(600);
                const card = await ev(`(() => { const v = document.getElementById('group-table-view'), e = v.querySelector('.empty-state'); return { card: e ? e.textContent.replace(/\\s+/g, ' ').trim() : null, note: !!v.querySelector('.inbox-filter-hidden'), rows: v.querySelectorAll('tbody tr:not(.dt-group)').length, above: !!e && [...v.querySelectorAll('tbody tr')].every(r => e.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
                assert.ok(/Nothing that needs you matches the search and filters\./.test(card.card || '') && /Show all/.test(card.card) && !card.note && card.rows >= 1 && card.above, `${w}: the filtered result is the card above the Getting started rows: ` + JSON.stringify(card));
                { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { await ev(`document.querySelectorAll('.notification-toast').forEach(t => t.remove()); true`); require('node:fs').writeFileSync(`${d}/filtered-empty-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
                await ev(`[...document.querySelectorAll('.empty-state button')].find(x => x.textContent.trim() === 'Show all').click(); true`); await settle(500);
                await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.settings = { ...state.settings, inbox_welcome: 'off' }; return true; })()`);
                await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await settle(400);
            }
            if (mobile) {
                const text = await ev(`document.getElementById('group-table-view').innerText.replace(/\\s+/g, ' ')`);
                assert.ok(/alpha-team/.test(text) && /beta-team/.test(text), `${w}: with two teams each row names its team: ` + text.slice(0, 300));
                continue;
            }
            // 1. a pill that hides one of the two says so
            const pill = label => ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills button, #group-table-view [role=group] button')].find(b => new RegExp('^${label}').test(b.textContent.trim())).click(); true`);
            await pill('Question'); await settle(400);
            const note = () => ev(`(() => { const p = document.querySelector('#group-table-view .inbox-filter-hidden'); return p ? { text: p.textContent.replace(/\\s+/g, ' ').trim(), link: !!p.querySelector('button, a') } : null; })()`);
            const n1 = await note();
            assert.ok(n1 && n1.text === '1 hidden by the Question filter. Show all' && n1.link, `${w}: the hidden one is said: ` + JSON.stringify(n1));
            await ev(`document.querySelector('#group-table-view .inbox-filter-hidden button, #group-table-view .inbox-filter-hidden a').click(); true`); await settle(400);
            assert.equal(await note(), null, `${w}: Show all clears it`);
            assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length`), 2, `${w}: both rows are back`);
            // leaving the Inbox resets the pill to All
            await pill('Question'); await settle(300);
            await ev(`window.switchNavTab('agents'); true`); await settle(300);
            await openNeeds();
            assert.equal(await note(), null, `${w}: back from another tab the pill is All and nothing is hidden`);
            assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length`), 2, `${w}: both rows listed again`);
            // 2. a search that matches nothing says so and has its own Show all (walk 52, #17160)
            await ev(`(() => { const i = document.getElementById('inbox-search'); i.value = 'zzz-no-such-item'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(500);
            const empty = () => ev(`(() => { const e = [...document.querySelectorAll('.empty-state')].find(x => /matches/.test(x.textContent)); const b = e && [...e.querySelectorAll('button')].find(x => x.textContent.trim() === 'Show all'); return { text: e ? e.textContent.replace(/\\s+/g, ' ').trim() : null, button: !!b }; })()`);
            const e1 = await empty();
            assert.ok(/matches the search and filters/.test(e1.text || '') && e1.button, `${w}: the empty result has a Show all: ` + JSON.stringify(e1));
            await ev(`[...document.querySelectorAll('.empty-state button')].find(x => x.textContent.trim() === 'Show all').click(); true`); await settle(500);
            assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length`), 2, `${w}: Show all brings both rows back`);
            assert.equal(await ev(`document.getElementById('inbox-search').value`), '', `${w}: and empties the search box`);
        }
        console.log('PASS Needs you says what a filter hides and names the teams');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
