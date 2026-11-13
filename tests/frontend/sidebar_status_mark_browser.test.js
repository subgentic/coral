// #15819 (design guidelines 4.5, A1): a team of sleeping agents showed seven red outlined chips ("Ended", "Terminal gone") cut off beside a Sleep button. A row has one status mark now: a shape and a word, the word in the text
// colour: the grey moon for an agent that ended or whose terminal is gone (Coral put it to sleep), the red cross only for a real error (its start failed for its CLI). The reason is the tooltip and the first line of the row menu.
// 1280 px and 390 px, dark and light, 200% text and forced-colors: no red on the sleeping rows, the mark and its word inside the row, and the glyph kept when colours are forced. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.clear(); true`);
        await ev(`(() => {
            const m = window.__m;
            for (const id of Object.keys(m.agents)) delete m.agents[id];
            for (const [n, l] of [['ended-a', 'A'], ['ended-b', 'B'], ['ended-c', 'C']]) m.add(n, l, 3, { sleeping: true, sleep_reason: 'agent_exited', board_project: 'sleepy-team' });
            for (const [n, l] of [['gone-d', 'D'], ['gone-e', 'E']]) m.add(n, l, 3, { sleeping: true, sleep_reason: 'terminal_gone', board_project: 'sleepy-team' });
            m.add('failed-f', 'F', 3, { sleeping: true, sleep_reason: 'coral_stopped', start_failure: 'cli_missing', start_failure_text: 'Its CLI is missing.', agent_type: 'codex', board_project: 'sleepy-team' });
            T.state.liveSessions = Object.values(m.agents).map(a => m.entry(a));
            T.render.renderLiveSessions(T.state.liveSessions);
            return true;
        })()`);
        await waitFor(`document.querySelectorAll('.session-group-item .terminal-gone-chip').length >= 6`, 'the six marked rows', 6000);
        const read = () => ev(`(() => {
            const rgb = v => { const p = document.createElement('i'); p.style.color = v; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
            const T = { text: rgb('var(--text-primary)'), muted: rgb('var(--text-muted)'), error: rgb('var(--error)') };
            const red = c => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?/.exec(c); return !!m && Number(m[4] ?? 1) > 0.02 && Number(m[1]) > Number(m[2]) + 60 && Number(m[1]) > Number(m[3]) + 60; };
            const rows = [...document.querySelectorAll('.session-group-item')].filter(li => li.querySelector('.terminal-gone-chip')).map(li => {
                const chip = li.querySelector('.terminal-gone-chip'), g = chip.querySelector('.status-glyph'), cs = getComputedStyle(chip), gs = getComputedStyle(g), row = li.querySelector('.session-name-row'), name = li.querySelector('.session-label'), r = e => e.getBoundingClientRect();
                                return { id: li.dataset.sessionId, word: chip.textContent.trim(), state: chip.dataset.state, title: chip.title, textColor: cs.color, wordRed: red(cs.color) || red(cs.backgroundColor) || red(cs.borderTopColor) && parseFloat(cs.borderTopWidth) > 0, glyphColor: gs.color, glyphW: Math.round(r(g).width), chipR: Math.round(r(chip).right), rowR: Math.round(r(row).right), nameR: name ? Math.round(r(name).right) : 0, chipL: Math.round(r(chip).left), shown: chip.getClientRects().length > 0, forceAdjust: gs.forcedColorAdjust };
            });
            return { T, rows }; })()`);
        await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`); // a colour read mid-transition is not the colour
        // The row menu starts with why the agent is asleep (the menu is drawn when it opens).
        for (const [id, want] of [['ended-a-id', 'Its program exited.'], ['gone-d-id', 'Its terminal is gone.']]) {
            await ev(`document.querySelector('.session-group-item[data-session-id="${id}"] .sidebar-kebab-btn').click(); true`);
            await waitFor(`!!document.querySelector('.session-group-item[data-session-id="${id}"] .sidebar-kebab-menu .overflow-menu-item')`, `the row menu of ${id} opens`, 4000);
            const note = await ev(`(document.querySelector('.session-group-item[data-session-id="${id}"] .sidebar-kebab-menu .overflow-menu-note') || { textContent: '' }).textContent.trim()`);
            check(note === want, `${id}: the row menu starts with why: "${note}"`);
            await ev(`document.querySelector('.session-group-item[data-session-id="${id}"] .sidebar-kebab-btn').click(); true`);
        }
        const MODES = [['1280 px dark', 1280, 800, false, 'dark', ''], ['1280 px light', 1280, 800, false, 'light', ''], ['390 px dark', 390, 844, true, 'dark', ''], ['390 px light', 390, 844, true, 'light', ''], ['1280 px 200% text', 1280, 800, false, 'dark', '200%'], ['390 px 200% text', 390, 844, true, 'dark', '200%']];
        for (const [label, w, h, mobile, theme, zoom] of MODES) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; T.render.renderLiveSessions(T.state.liveSessions); true`);
            await waitFor(`(() => { const c = document.querySelector('.session-group-item .terminal-gone-chip'); return !!c && c.getClientRects().length > 0 && c.querySelector('.status-glyph')?.getClientRects().length > 0; })()`, `${label}: the marks are laid out`, 6000);
            const d = await read();
            const at = label + ': ';
            check(d.rows.length === 6 && d.rows.every(r => r.shown), `${at}six marked rows, all shown (${d.rows.length})`);
            for (const r of d.rows) {
                const sleeping = !r.id.startsWith('failed');
                check(r.state === (sleeping ? 'sleeping' : 'failed'), `${at}${r.id} is the ${sleeping ? 'moon (sleeping)' : 'cross (a real error)'}: ${r.state}`);
                check(r.word === (r.id.startsWith('ended') ? 'Ended' : r.id.startsWith('gone') ? 'Terminal gone' : 'Failed to start'), `${at}${r.id} word: ${r.word}`);
                check(r.textColor === d.T.text && !r.wordRed, `${at}${r.id}: the word is the text colour, no red chip (${r.textColor})`);
                check(r.glyphColor === (sleeping ? d.T.muted : d.T.error), `${at}${r.id}: the shape is ${sleeping ? 'grey' : 'red'} (${r.glyphColor})`);
                check(r.glyphW === 10 || zoom, `${at}${r.id}: the shape is drawn (${r.glyphW})`);
                check(r.chipR <= r.rowR + 1 && r.chipL >= r.nameR - 1, `${at}${r.id}: the mark and its word sit inside the row, after the name: ${JSON.stringify([r.chipL, r.chipR, r.nameR, r.rowR])}`);
                check(/restart|exited|terminal|CLI/i.test(r.title), `${at}${r.id}: the reason is the tooltip (${r.title})`);
            }
            if (label === '1280 px dark' || label === '390 px light' || label === '1280 px 200% text') await shot('sidebar-status-' + label.replace(/ /g, '-'));
        }
        await ev(`document.documentElement.style.fontSize = ''; document.documentElement.setAttribute('data-theme', 'dark'); true`);
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'active' }] });
        await ev(`T.render.renderLiveSessions(T.state.liveSessions); true`);
        const f = await read();
        check(f.rows.length === 6 && f.rows.every(r => r.forceAdjust === 'none'), 'forced-colors: the shape keeps its drawing (forced-color-adjust none): ' + JSON.stringify(f.rows.map(r => r.forceAdjust)));
        await Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'none' }] });
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'The sidebar status marks:\n  ' + problems.join('\n  '));
    console.log('PASS the sidebar rows have one status mark: the moon, and the cross only for a real error');
})().catch(e => { console.error(e); process.exit(1); });
