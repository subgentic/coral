// #13171 (the Operator): an agent whose terminal is gone can be put to Sleep, not only woken. Its row has a Sleep button beside the Terminal gone chip, its menu has Sleep, and when several are gone a row
// says "Sleep N terminal-gone agents". Sleep asks nothing (nothing runs to stop), files the agent under sleeping (no Terminal gone chip, a plain sleeper that a Wake resumes) and says so in a toast; the bulk row
// sends one request naming those agents. An awake agent, a plain sleeper and an archived agent are unchanged.
//
// The agents are one team (a bulk row is per team or folder group).
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { coralReady, framesJs } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired();
        await install();
        await coralReady(ev);
        await ev(`(async () => {
            window.__m.add('gone-1', 'G', 3, { sleeping: true, sleep_reason: 'terminal_gone', board_project: 'gone-team' });
            window.__m.add('gone-2', 'G', 3, { sleeping: true, sleep_reason: 'terminal_gone', board_project: 'gone-team' });
            window.__m.add('gone-3', 'G', 3, { sleeping: true, sleep_reason: 'terminal_gone', board_project: 'gone-team' });
            window.__m.add('nap', 'N', 3, { sleeping: true, board_project: 'gone-team' });
            window.__m.add('arch', 'A', 3, { archived: true, sleep_reason: 'terminal_gone', board_project: 'gone-team' });
            window.__m.add('busy', 'B', 3, { sleeping: false, board_project: 'gone-team' });
            // the server's two answers, on top of the harness: Sleep of one agent and Sleep all terminal-gone
            window.__calls = [];
            const f = window.fetch;
            window.fetch = (url, opts = {}) => {
                const u = String(url), m = u.match(/\\/api\\/sessions\\/live\\/([^/?]+)\\/sleep$/);
                if ((opts.method || 'GET') === 'POST' && u.endsWith('/api/sessions/live/sleep-gone')) {
                    const ids = JSON.parse(opts.body).session_ids; window.__calls.push({ kind: 'bulk', ids });
                    return Promise.resolve(new Response(JSON.stringify({ ok: true, sessions_affected: ids.length }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }
                if ((opts.method || 'GET') === 'POST' && m && m[1] !== 'wake-all') {
                    window.__calls.push({ kind: 'one', id: decodeURIComponent(m[1]) });
                    return Promise.resolve(new Response(JSON.stringify({ ok: true, sleeping: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }
                return f(url, opts);
            };
            window.T.render.renderLiveSessions(window.T.state.liveSessions);
            return true;
        })()`);
        const rowInfo = id => ev(`(() => { const li = document.querySelector('.session-group-item[data-session-id="${id}"]'); if (!li) return null;
            const btn = [...li.querySelectorAll('button')].find(b => b.dataset.mode === 'sleep');
            return { chip: !!li.querySelector('.terminal-gone-chip'), sleepBtn: btn ? { text: btn.textContent.trim(), aria: btn.getAttribute('aria-label') } : null, text: li.textContent.replace(/\\s+/g, ' ') }; })()`);
        const bulk = () => ev(`(() => { const b = document.querySelector('.sleep-gone-row button'); return b ? { text: b.textContent.trim(), aria: b.getAttribute('aria-label'), ids: b.dataset.ids } : null; })()`);

        for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await ev(`window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
            await ev(framesJs(2));
            for (const id of ['gone-1-id', 'gone-2-id', 'gone-3-id']) {
                const r = await rowInfo(id);
                assert.ok(r && r.chip, `${width}: ${id} is a Terminal gone row`);
                assert.ok(r.sleepBtn && r.sleepBtn.text === 'Sleep' && /^Put .+ to sleep$/.test(r.sleepBtn.aria), `${width}: ${id} has a Sleep button named for the agent: ${JSON.stringify(r.sleepBtn)}`);
            }
            for (const id of ['nap-id', 'arch-id', 'busy-id']) {
                const r = await rowInfo(id);
                assert.ok(!r || r.sleepBtn === null, `${width}: ${id} has no Sleep button for a gone terminal`);
            }
            const b = await bulk();
            assert.ok(b && b.text === 'Sleep 3 terminal-gone agents', `${width}: the bulk row says how many: ${JSON.stringify(b)}`);
            assert.deepEqual(b.ids.split(',').sort(), ['gone-1-id', 'gone-2-id', 'gone-3-id']);
            if (process.env.CORAL_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
                fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/sleep-terminal-gone-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            }
        }
        console.log('   ✓ rows: Sleep beside the Terminal gone chip, a bulk row naming the count; others unchanged');

        // the menu offers Sleep for a gone agent, and not for a plain sleeper
        const menu = id => ev(`(() => { const li = document.querySelector('.session-group-item[data-session-id="${id}"]'); window.closeSidebarKebabs(); li.querySelector('.sidebar-kebab-btn').click();
            return [...li.querySelectorAll('.sidebar-kebab-menu .overflow-menu-item')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()); })()`);
        assert.ok((await menu('gone-1-id')).includes('Sleep'), 'the menu of a terminal-gone agent offers Sleep');
        assert.ok(!(await menu('nap-id')).includes('Sleep'), 'a plain sleeper has no Sleep item');
        await ev(`window.closeSidebarKebabs(); true`);
        console.log('   ✓ menu: Sleep for a terminal-gone agent only');

        // Sleep on one row: no confirmation, one request, the chip goes and the agent is a plain sleeper
        await ev(`document.querySelector('.session-group-item[data-session-id="gone-1-id"] button[data-mode="sleep"]').click(); true`);
        await ev(framesJs(3));
        const modal = await ev(`(() => { const m = document.getElementById('confirm-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`);
        assert.equal(modal, false, 'Sleep of an agent that is asleep already asks nothing');
        assert.deepEqual(await ev('window.__calls'), [{ kind: 'one', id: 'gone-1-id' }]);
        const after = await rowInfo('gone-1-id');
        assert.ok(!after || (!after.chip && after.sleepBtn === null), `the agent is no longer Terminal gone: ${JSON.stringify(after)}`);
        const reason = await ev(`window.T.state.liveSessions.find(s => s.session_id === 'gone-1-id').sleep_reason`);
        assert.equal(reason, null, 'a plain sleeper');
        const toast = await ev(`[...document.querySelectorAll('.toast, [role="status"]')].map(e => e.textContent).join(' | ')`);
        assert.ok(/now sleeping/.test(toast), 'it says so: ' + toast);
        console.log('   ✓ Sleep: no question, one request, filed under sleeping');

        // the bulk row now names two; one request with those two
        const b2 = await bulk();
        assert.ok(b2 && b2.text === 'Sleep 2 terminal-gone agents', JSON.stringify(b2));
        await ev(`document.querySelector('.sleep-gone-row button').click(); true`);
        await ev(framesJs(3));
        const calls = await ev('window.__calls');
        assert.equal(calls.length, 2);
        assert.equal(calls[1].kind, 'bulk');
        assert.deepEqual(calls[1].ids.sort(), ['gone-2-id', 'gone-3-id'], 'the agents the person saw, and no other');
        assert.equal(await bulk(), null, 'no terminal-gone agent is left: the row is gone');
        for (const id of ['gone-2-id', 'gone-3-id']) {
            assert.equal(await ev(`window.T.state.liveSessions.find(s => s.session_id === '${id}').sleep_reason`), null, id);
        }
        assert.equal(await ev(`window.T.state.liveSessions.find(s => s.session_id === 'arch-id').sleep_reason`), 'terminal_gone', 'an archived agent is not moved');
        console.log('   ✓ bulk: one request naming the agents; the row goes');

        // #13222: when the server moves fewer agents than asked (here none: they changed meanwhile), no Terminal gone marker is cleared by guess; the rows are read again from the server
        await ev(`(async () => {
            window.__m.add('late-1', 'L', 3, { sleeping: true, sleep_reason: 'terminal_gone', board_project: 'late-team' });
            window.__m.add('late-2', 'L', 3, { sleeping: true, sleep_reason: 'terminal_gone', board_project: 'late-team' });
            window.__affected = 0; window.__listReads = 0;
            const f = window.fetch;
            window.fetch = (url, opts = {}) => {
                const u = String(url);
                if ((opts.method || 'GET') === 'POST' && u.endsWith('/api/sessions/live/sleep-gone')) {
                    const ids = JSON.parse(opts.body).session_ids; window.__calls.push({ kind: 'bulk', ids });
                    return Promise.resolve(new Response(JSON.stringify({ ok: true, sessions_affected: window.__affected }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }
                if (u.split('?')[0].endsWith('/api/sessions/live')) window.__listReads++;
                return f(url, opts);
            };
            window.T.render.renderLiveSessions(window.T.state.liveSessions);
            return true;
        })()`);
        await ev(framesJs(2));
        const bulkLate = await ev(`(() => { const b = document.querySelector('.sleep-gone-row button'); return b ? b.textContent.trim() : null; })()`);
        assert.equal(bulkLate, 'Sleep 2 terminal-gone agents');
        await ev(`document.querySelector('.sleep-gone-row button').click(); true`);
        await ev(framesJs(4));
        for (const id of ['late-1-id', 'late-2-id']) {
            assert.equal(await ev(`window.T.state.liveSessions.find(s => s.session_id === '${id}').sleep_reason`), 'terminal_gone', `${id}: still Terminal gone: the server moved none`);
        }
        assert.ok((await ev('window.__listReads')) >= 1, 'the rows were read again from the server');
        console.log('   ✓ a short answer reads the rows again and clears no marker by guess');
        console.log('PASS sleep_terminal_gone_browser');
    } finally {
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
