// Activity's Kind menu (#16087, #22100 the approved mock): Important | Everything stays a two-part switch and the kinds are one Kind menu with their counts; several at once, "All" clears them, no filter chip or
// badge repeats the choice, the counts stay what they were, and the choice is kept for a reload as the filters are. The record is stubbed in the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (w, theme, keep) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 }); await Emulation.setTouchEmulationEnabled({ enabled: w < 500 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => {
            const prefix = window.__coralStatic || '/static/', ago = m => new Date(Date.now() - m * 60000).toISOString(), json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
            const row = (id, action, item_kind, item_id, title, note) => ({ id, at: ago(id), team: 'tm', action, item_kind, item_id: String(item_id), title, note, source: 'dashboard' });
            const rows = [row(7, 'answer', 'question', 7, 'Ship it?', 'yes'), row(6, 'task_complete', 'task', 12, 'Ship release', ''), row(5, 'prompt_allow', 'agent', 'claude-ada', 'claude-ada', 'Yes, once'), row(4, 'prompt_reject', 'agent', 'claude-bob', 'claude-bob', 'No'), row(3, 'chat_send', 'chat', 'board:tm', 'tm', 'hello'), row(2, 'approve', 'file', 'a'.repeat(64), 'plan.md', ''), row(1, 'file_star', 'file', 'b'.repeat(64), 'notes.md', '')];
            const original = window.fetch;
            window.fetch = (url, opts = {}) => new URL(String(url), location.origin).pathname === '/api/activity' ? json({ actions: rows, check: { intact: true, rows: rows.length } }) : original(url, opts);
            ${keep ? '' : "localStorage.setItem('coral-inbox-activity-filters', JSON.stringify({ important: false }));"} // Everything, as a browser that kept the earlier default has it (Important is the default of a browser that kept nothing, #19149)
            const m = await import(prefix + 'settings_core.js'); m.applyTheme('${theme}');
            window.switchNavTab('hub-inbox');
            await (await import(prefix + 'inbox_sidebar.js')).openInboxGroup('activity');
        })()`);
        await waitFor(`document.querySelectorAll('#group-table-view .al-row').length > 0`, 'the record is drawn');
    };
    const rowsNow = () => ev(`document.querySelectorAll('#group-table-view .al-row').length`);
    const menuItemsOpen = async () => { await openMenu(); return menuItems(); };
    const kindWord = () => ev(`(document.querySelector('.al-kind-menu .task-more-btn') || {}).textContent`);
    const menuItems = () => ev(`[...document.querySelectorAll('#inbox-activity-kind-menu [role^="menuitem"]')].map(b => ({ text: b.textContent.replace(/\\s+/g, ' ').trim(), on: b.getAttribute('aria-checked') }))`);
    const openMenu = async () => { assert.ok(await ev(`(() => { const b = document.querySelector('#inbox-activity-kind'); if (!b || !b.getClientRects().length) return false; b.click(); return true; })()`), 'the Kind button is there to press'); await waitFor(`!document.querySelector('#inbox-activity-kind-menu').hidden`, 'the Kind menu opens'); };
    const pick = async word => { await openMenu(); assert.ok(await ev(`(() => { const b = [...document.querySelectorAll('#inbox-activity-kind-menu [role^="menuitem"]')].find(x => x.textContent.trim().startsWith(${JSON.stringify(word)})); if (!b) return false; b.click(); return true; })()`), `the ${word} item is there`); await ev(framesJs(4)); };
    const clipped = () => ev(`(() => { const bar = document.querySelector('.inbox-folder-toolbar'), br = bar.getBoundingClientRect(), out = []; for (const e of bar.querySelectorAll('.al-switch, .al-kind-menu, .list-bar-search-wrap, .list-bar-toggle')) if (e.getClientRects().length) { const r = e.getBoundingClientRect(); if (r.right > br.right + 1 || r.left < br.left - 1) out.push(e.className); } return out; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme] of [[1440, 'dark'], [1440, 'light'], [1100, 'dark'], [900, 'light'], [768, 'dark'], [390, 'dark'], [390, 'light']]) {
            const tag = `${w}-${theme}`;
            await open(w, theme, false);
            assert.equal(await rowsNow(), 6, `${tag}: Everything shows all six (a send to an agent is in the record but not a row, #18466)`);
            assert.equal(await ev(`[...document.querySelectorAll('.al-switch .al-switch-btn')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed')).join('|')`), 'Important:false|Everything:true', `${tag}: the two-part switch, on Everything`);
            assert.equal(await ev(`!!document.querySelector('.team-tb-pills')?.getClientRects().length`), false, `${tag}: the seven tabs are gone`);
            assert.equal(await kindWord(), 'Kind: All \u25be', `${tag}: the Kind menu says All`);
            const counts = (await menuItemsOpen()).map(i => i.text); await ev(`document.querySelector('#inbox-activity-kind').click(); true`);
            assert.ok(counts.some(t => /^All \d+$/.test(t)) && counts.some(t => /^Permissions \d+$/.test(t)), `${tag}: every kind keeps its count in the menu: ${JSON.stringify(counts)}`);
            await pick('Words sent'); await pick('Permissions');
            assert.equal(await kindWord(), 'Kind: 2 kinds \u25be', `${tag}: two kinds are on together`);
            assert.equal(await rowsNow(), 2, `${tag}: the two kinds' rows (two permissions; the word has no row, #18466)`);
            assert.deepEqual((await menuItemsOpen()).map(i => i.text), counts, `${tag}: the counts do not move with the choice`);
            await shot(`kinds-menu-open-${tag}`); // the Kind menu open, two kinds ticked
            await ev(`document.querySelector('#inbox-activity-kind').click(); true`);
            assert.equal(await ev(`[...document.querySelectorAll('.list-bar-chip, .team-tb-chip')].filter(e => e.getClientRects().length).map(e => e.textContent).join('|')`), '', `${tag}: no filter chip repeats the kinds`);
            assert.equal(await ev(`!!document.querySelector('.inbox-folder-toolbar .list-bar-toggle .display-badge:not([hidden])')`), false, `${tag}: and no badge counts them`);
            assert.deepEqual(await clipped(), [], `${tag}: nothing in the top line is cut`);
            assert.ok(await ev(`[...document.querySelectorAll('.al-kind-menu .task-more-btn, .al-switch button')].every(b => b.getBoundingClientRect().height >= ${w < 500 ? 44 : 28})`), `${tag}: the controls are ${w < 500 ? '44 px' : 'a normal height'}: ` + JSON.stringify(await ev(`[...document.querySelectorAll('.al-kind-menu .task-more-btn, .al-switch button')].map(b => [b.className, Math.round(b.getBoundingClientRect().height)])`)));
            await shot(`kinds-two-${tag}`);
            await pick('Words sent'); assert.equal(await kindWord(), 'Kind: Permissions \u25be', `${tag}: picking a kind again takes it off`);
            await pick('All'); assert.equal(await kindWord(), 'Kind: All \u25be', `${tag}: All clears the others`); assert.equal(await rowsNow(), 6);
            await pick('Files'); await pick('Decisions'); // the choice is kept: a reload brings the same kinds back
            const kept = await ev(`JSON.parse(localStorage.getItem('coral-inbox-activity-filters') || '{}')`);
            assert.deepEqual([...(kept.kind || [])].sort(), ['decisions', 'files'], `${tag}: kept in the browser: ${JSON.stringify(kept)}`);
            const before = await rowsNow();
            await open(w, theme, true);
            assert.equal(await kindWord(), 'Kind: 2 kinds \u25be', `${tag}: after a reload the same kinds are on`);
            assert.equal(await rowsNow(), before, `${tag}: and the same rows`);
            await ev(`document.querySelector('.al-switch .al-switch-btn').click(); true`); await ev(framesJs(4));
            assert.equal(await ev(`document.querySelector('.al-switch .al-switch-btn').getAttribute('aria-pressed')`), 'true', `${tag}: Important is on`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
