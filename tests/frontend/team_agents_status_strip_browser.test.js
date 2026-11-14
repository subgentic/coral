// Team Agents says one word for a working agent and keeps four filter pills (#15830, design guidelines T8 and 4.5): "Working" with the shared status mark (a shape and a word, no blue) for a busy agent and for an
// idle agent whose task is started (the task number stays in Doing); a strip of All, Working, Has a task and Sleeping; every other state in a More select; the counts add up to All. 1440 and 390, dark and light,
// 200% text. The board's /status answer is stubbed. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-strip15830-${Date.now() % 100000}`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const failures = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, availability, tasks = []) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason: '', tasks });
                const agents = [a('Busy One', 'busy', [{ id: 7, status: 'in_progress', title: 'Ship it' }]), a('Worker', 'task_idle', [{ id: 1, status: 'in_progress', title: 'Write the hours report' }]), a('Waiter', 'task_idle', [{ id: 2, status: 'pending', title: 'Review it' }]), a('Free One', 'available'), a('Sleeper', 'sleeping'), a('Asker', 'needs_input'), a('Gone', 'offline'), a('Quiet', 'unknown')];
                return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 8, available: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        for (const [width, theme, zoom] of [[1440, 'dark', ''], [1440, 'light', ''], [1440, 'dark', '200%'], [390, 'dark', ''], [390, 'light', '']]) {
            const at = `${width} ${theme}${zoom ? ' ' + zoom + ' text' : ''}`;
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                await openTeam(ev, waitFor, TEAM); await settle(500);
                await goTab(ev, settle, 'Agents');
                await waitFor(`[...document.querySelectorAll('#team-panel-agents tr.dt-row')].filter(r => r.getClientRects().length).length === 8`, at + ': the eight agents', 10000);
                const ok = (cond, what, extra) => { if (!cond) failures.push(`${at}: ${what} ${JSON.stringify(extra === undefined ? null : extra)}`); };
                const read = () => ev(`(() => { const p = document.querySelector('#team-panel-agents'); const row = r => { const m = r.querySelector('.status-mark'); return { name: r.textContent.slice(0, 12), word: m ? m.querySelector('.status-word').textContent.trim() : null, state: m ? m.dataset.state : null, chip: !!(m ? m.closest('td') : r).querySelector('.dt-chip'), blue: !!(m ? m.closest('td') : r).querySelector('.goal-state-active') }; };
                    const vis = [...p.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length), sel = p.querySelector('.team-tb-more'), pills = [...p.querySelectorAll('.team-tb-pills .goals-chip')];
                    return { rows: vis.map(row), pills: pills.map(c => ({ key: c.dataset.filter, text: c.textContent.replace(/\\s+/g, ' ').trim(), on: c.getAttribute('aria-pressed') })), more: sel ? [...sel.options].map(o => ({ key: o.value, text: o.textContent.trim() })) : [], moreOn: sel ? sel.dataset.on : null, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
                const d = await read();
                const words = d.rows.map(r => r.word).sort();
                ok(JSON.stringify(words) === JSON.stringify(['Ended', 'Free', 'Has a task', 'Needs input', 'Not reported', 'Sleeping', 'Working', 'Working']), 'one word per state, Working for busy and for a started task', words);
                ok(d.rows.every(r => r.state && !r.chip && !r.blue), 'every status is the shared mark, no chip and no blue state', d.rows);
                ok(d.rows.filter(r => r.word === 'Working').every(r => r.state === 'working') && d.rows.find(r => r.word === 'Sleeping').state === 'sleeping' && d.rows.find(r => r.word === 'Needs input').state === 'waiting', 'the marks: working, sleeping, waiting', d.rows);
                ok(JSON.stringify(d.pills.map(p => p.key)) === JSON.stringify(['all', 'working', 'has_task', 'sleeping']), 'the strip is All, Working, Has a task, Sleeping', d.pills);
                const n = text => Number((text.match(/(\d+)$/) || [])[1]);
                const strip = Object.fromEntries(d.pills.map(p => [p.key, n(p.text)])), more = d.more.filter(o => o.key).map(o => n(o.text));
                ok(strip.all === 8 && strip.working === 2 && strip.has_task === 1 && strip.sleeping === 1, 'the strip counts', strip);
                ok(strip.working + strip.has_task + strip.sleeping + more.reduce((a, b) => a + b, 0) === strip.all, 'the strip and the More counts add up to All', { strip, more });
                ok(d.sideways <= 1, 'no sideways scroll', d.sideways);
                const doing = await ev(`[...document.querySelectorAll('#team-panel-agents tr.dt-row')].find(r => /Worker/.test(r.textContent)).textContent`);
                ok(/#1/.test(doing), 'the task number is in Doing', doing);
                if (width === 1440 && !zoom) { // the More select is a real way to a state
                    await ev(`(() => { const s = document.querySelector('#team-panel-agents .team-tb-more'); s.value = 'available'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                    await settle(300);
                    const f = await read();
                    ok(f.rows.length === 1 && f.rows[0].word === 'Free' && f.moreOn === 'true' && f.pills.every(p => p.on === 'false'), 'More: Free shows the one free agent and no strip pill is pressed', f);
                    await ev(`document.querySelector('#team-panel-agents .goals-chip[data-filter="all"]').click(); true`); await settle(300);
                }
                if (['1440 dark', '1440 light', '390 dark'].includes(at)) await shot('team-agents-status-' + at.replace(/ /g, '-'));
            } catch (e) { failures.push(`${at}: ${e.message}`); }
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    assert.deepEqual(failures, [], 'Team Agents status:\n  ' + failures.join('\n  '));
    console.log('PASS Team Agents: one Working word with the status mark, a strip of four, the rest in More');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
