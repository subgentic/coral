// Activity's kind chips (#16087, the Operator): several kinds at once, Everything clears them, no 'Kind: X' filter chip or badge repeats the choice over the strip, no chip is clipped at any width,
// the counts stay what they were, and the choice is kept for a reload as the filters are. The record is stubbed in the page.
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
            ${keep ? '' : "localStorage.removeItem('coral-inbox-activity-filters');"}
            const m = await import(prefix + 'settings_core.js'); m.applyTheme('${theme}');
            window.switchNavTab('hub-inbox');
            await (await import(prefix + 'inbox_sidebar.js')).openInboxGroup('activity');
        })()`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length > 0`, 'the record is drawn');
    };
    const rowsNow = () => ev(`document.querySelectorAll('#group-table-view tbody tr').length`);
    const pressed = () => ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip[aria-pressed="true"]')].map(b => b.dataset.filter)`);
    const panelChecks = () => ev(`[...document.querySelectorAll('.inbox-pill-field .team-tb-checks input')].map(i => i.checked)`);
    const pick = async key => { assert.ok(await ev(`(() => { const b = document.querySelector('.team-tb-pills .goals-chip[data-filter="${key}"]'); if (!b || !b.getClientRects().length) return false; b.click(); return true; })()`), `the ${key} chip is there to press`); await ev(framesJs(4)); };
    // nothing the strip holds is cut: every pill and chip in it lies whole inside it (the strip may stand aside for the panel's check boxes instead)
    const clipped = () => ev(`(() => { const out = []; const strip = document.querySelector('.inbox-folder-toolbar .list-bar-search-row'); const sr = strip.getBoundingClientRect();
        const pills = strip.querySelector('.team-tb-pills'); if (pills && pills.getClientRects().length) { const pr = pills.getBoundingClientRect(); if (pills.scrollWidth > pills.clientWidth + 1) out.push('pills scroll: ' + pills.scrollWidth + ' > ' + pills.clientWidth);
            for (const b of pills.querySelectorAll('.goals-chip')) { const r = b.getBoundingClientRect(); if (r.left < pr.left - 1 || r.right > pr.right + 1) out.push('cut: ' + b.textContent.trim()); } }
        for (const e of strip.querySelectorAll('.goals-chip, .list-bar-chip, .team-tb-chip')) if (e.getClientRects().length) { const r = e.getBoundingClientRect(); if (r.right > sr.right + 1) out.push('past the strip: ' + e.textContent.trim()); }
        return out; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme] of [[1440, 'dark'], [1440, 'light'], [1100, 'dark'], [900, 'light'], [768, 'dark'], [390, 'dark'], [390, 'light']]) {
            const tag = `${w}-${theme}`, wide = await (async () => { await open(w, theme, false); return await ev(`!!document.querySelector('.team-tb-pills')?.getClientRects().length`); })();
            assert.equal(await rowsNow(), 7, `${tag}: Everything shows all seven`);
            const counts = await ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
            if (wide) {
                await pick('words'); await pick('permissions');
                assert.deepEqual(await pressed(), ['permissions', 'words'], `${tag}: two kinds are on together`);
                assert.equal(await rowsNow(), 3, `${tag}: the two kinds' rows (two permissions, one word)`);
                assert.deepEqual(await ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`), counts, `${tag}: the counts do not move with the choice`);
                assert.equal(await ev(`[...document.querySelectorAll('.list-bar-chip, .team-tb-chip')].filter(e => e.getClientRects().length).map(e => e.textContent).join('|')`), '', `${tag}: no filter chip repeats the kinds over the strip`);
                assert.equal(await ev(`!!document.querySelector('.inbox-folder-toolbar .list-bar-toggle .display-badge:not([hidden])')`), false, `${tag}: and no badge counts them`);
                assert.deepEqual(await clipped(), [], `${tag}: nothing in the strip is cut`);
                await shot(`kinds-two-${tag}`);
                await pick('words'); assert.deepEqual(await pressed(), ['permissions'], `${tag}: pressing a kind again takes it off`);
                await pick('words'); await pick('all'); assert.deepEqual(await pressed(), ['all'], `${tag}: Everything clears the others`); assert.equal(await rowsNow(), 7);
                await pick('files'); await pick('decisions'); // the choice is kept: a reload brings the same chips back
                const kept = await ev(`JSON.parse(localStorage.getItem('coral-inbox-activity-filters') || '{}')`);
                assert.deepEqual([...(kept.kind || [])].sort(), ['decisions', 'files'], `${tag}: kept in the browser: ${JSON.stringify(kept)}`);
                const before = await rowsNow();
                await open(w, theme, true);
                assert.deepEqual(await pressed(), ['decisions', 'files'], `${tag}: after a reload the same kinds are on`);
                assert.equal(await rowsNow(), before, `${tag}: and the same rows`);
            } else {
                await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`);
                await waitFor(`!!document.querySelector('.inbox-pill-field .team-tb-checks')?.getClientRects().length`, `${tag}: the panel lists the kinds as check boxes`);
                const tick = n => ev(`(() => { const i = [...document.querySelectorAll('.inbox-pill-field .team-tb-checks input')][${n}]; i.click(); return true; })()`);
                await tick(5); await ev(framesJs(4)); await tick(3); await ev(framesJs(4));
                const checks = await panelChecks();
                assert.deepEqual(checks, [false, false, false, true, false, true], `${tag}: two kinds ticked together: ${JSON.stringify(checks)}`);
                assert.equal(await rowsNow(), 3, `${tag}: their rows`);
                await shot(`kinds-two-${tag}`);
                await ev(`document.querySelector('.inbox-pill-field .team-tb-checks input').click(); true`); await ev(framesJs(4));
                assert.deepEqual(await panelChecks(), [true, false, false, false, false, false], `${tag}: Everything clears the others`);
                assert.equal(await rowsNow(), 7);
            }
        }
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
