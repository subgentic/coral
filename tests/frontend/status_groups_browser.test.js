// #21466 (the Operator's approved concept mocks v3, idea 4): the agent list grouped by status, the default, with a Team | Status switch whose choice is remembered.
//   1. a fresh profile opens on Status: Needs you, Working, Idle, then Done today, folded; each heading has its count, no row has a status dot, and a group's rows run newest update first;
//   2. Done today opens from its heading with a real click; the choice is kept after a reload;
//   3. the Team button brings back the teams (the orchestrator card), is remembered across a reload, and Status brings the groups back;
//   4. a phone shows every agent that needs you, two working, and one line: "2 more working · 3 idle · 6 done today", which opens the rest;
//   5. an agent that comes back with output moves up (a working agent's update is newer than the others'), and an agent that asks a question moves to Needs you.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect({ grouping: 'status' });
    const { Input } = client;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // One that needs you, four working, three idle (one of them a team's), six that finished today; the orchestrator is on a team of its own
        const scene = () => ev(`(async () => {
            window.__rows = {}; T.state.liveSessions = []; window.__m.agents = {};
            const add = (name, seconds, extra, opts) => { window.__m.add(name, name.slice(0, 1).toUpperCase(), 1, { sleeping: false, ...opts }); Object.assign(T.state.liveSessions.find(s => s.name === name), { staleness_seconds: seconds, ...extra }); };
            add('ask-407', 360, { waiting_for_input: true });
            add('Orchestrator', 0, { working: true }, { board_project: 'shop' });
            add('work-409', 1, { working: true });
            add('work-410', 120, { working: true });
            add('work-411', 300, { working: true });
            add('idle-designer', 1080, {});
            add('idle-402', 3600, {});
            add('idle-qa', 3700, {});
            for (let i = 0; i < 6; i++) add('done-' + i, 7200 + i, { archived: true }, { archived: true });
            // The scene is also what the mocked server answers, so a live-list read that lands late (CI is slower than the page's first read) returns these same rows and does not replace the scene with bare ones (#21725).
            window.__rows = Object.fromEntries(T.state.liveSessions.map(s => [s.name, { ...s }]));
            const base = window.__m.entry.__base || window.__m.entry, answer = a => (window.__rows[a.name] ? { ...window.__rows[a.name] } : base.call(window.__m, a)); answer.__base = base; window.__m.entry = answer;
            window.__patch = (name, fields) => { for (const r of [window.__rows[name], T.state.liveSessions.find(s => s.name === name)]) if (r) Object.assign(r, fields); };
            T.render.renderLiveSessions(T.state.liveSessions); return T.state.liveSessions.length; })()`);
        const list = phone => phone ? '#mobile-agent-list' : '.sidebar';
        const load = async view => {
            await Emulation.setDeviceMetricsOverride({ width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`try { localStorage.setItem('coral-show-model', 'false'); } catch (e) {} true`);
        };
        const picture = phone => ev(`(() => {
            const root = document.querySelector(${JSON.stringify(list(phone))});
            const out = []; let group = '';
            for (const li of root.querySelectorAll('li')) {
                if (li.classList.contains('status-head')) { group = li.dataset.status; out.push({ head: group, name: li.querySelector('.status-name').textContent.trim(), n: Number(li.querySelector('.session-group-count').textContent), open: li.querySelector('button').getAttribute('aria-expanded') }); }
                else if (li.classList.contains('session-group-item')) out.push({ row: (li.dataset.name || li.getAttribute('aria-label') || '').split(',')[0], group, dot: !!li.querySelector('.session-dot') && getComputedStyle(li.querySelector('.session-dot')).display !== 'none', time: li.querySelector('.session-time')?.textContent });
                else if (li.classList.contains('status-more')) out.push({ more: li.textContent.replace(/\\s+/g, ' ').trim() });
            }
            return { out, switchOn: [...root.querySelectorAll('.status-switch [aria-pressed="true"]')].map(b => b.textContent.trim()), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        })()`);
        const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}-${process.env.LOOK_THEME || 'dark'}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // LOOK_THEME=light|dark picks the theme
        const click = async sel => { // a real press on the element (after checking that it is what is under that point)
            const box = JSON.parse(await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'null'; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return JSON.stringify({ x, y, ok: hit === e || e.contains(hit) }); })()`));
            assert.ok(box && box.ok, `${sel} is under its own point`);
            for (const type of ['mousePressed', 'mouseReleased']) await Input.dispatchMouseEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
        };

        console.log('computer: a fresh profile opens on Status');
        await load({ width: 1440, height: 900, mobile: false });
        await ev(`try { localStorage.removeItem('coral-agent-grouping'); } catch (e) {} true`);
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        assert.equal(await scene(), 14);
        await waitFor(`!!document.querySelector('.sidebar .status-head')`, 'the status groups', 6000);
        await ev(`import((window.__coralStatic || '/static/') + 'api.js').then(m => m.loadLiveSessions()).then(() => true)`); // a live-list read that lands after the scene (CI's slower first read): the mocked server answers with the scene, so the list does not change (#21725)
        await waitFor(`!!document.querySelector('.sidebar .status-head')`, 'the groups after the read', 6000);
        let p = await picture(false);
        assert.deepEqual(p.out.filter(x => x.head).map(x => [x.head, x.name, x.n]), [['needs', 'Needs you', 1], ['working', 'Working', 4], ['idle', 'Idle', 3], ['done', 'Done today', 6]], 'the four groups, in order, with their counts');
        assert.deepEqual(p.out.filter(x => x.head).map(x => x.open), ['true', 'true', 'true', 'false'], 'Done today is folded');
        assert.deepEqual(p.out.filter(x => x.row).map(x => x.row), ['ask-407', 'Orchestrator', 'work-409', 'work-410', 'work-411', 'idle-designer', 'idle-402', 'idle-qa'], 'newest update first inside each group');
        assert.ok(p.out.filter(x => x.row).every(x => !x.dot), 'a row has no status dot: its heading is the status');
        assert.equal(p.out.find(x => x.row === 'work-410').time, '2 min');
        assert.deepEqual(p.switchOn, ['Status']);
        await shot('status-desktop-1440');

        console.log('computer: Done today opens from its heading, and the choice stays after a reload');
        await click('.sidebar .status-head[data-status="done"] button');
        await shot('status-desktop-1440-done-open');
        await waitFor(`document.querySelectorAll('.sidebar .session-group-item[data-group="__status__"]').length === 14`, 'the six that finished today', 4000);
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await scene(); await waitFor(`!!document.querySelector('.sidebar .status-head')`, 'the groups again', 6000);
        p = await picture(false);
        assert.equal(p.out.find(x => x.head === 'done').open, 'true', 'Done today stays open after a reload');

        console.log('computer: Team brings back the teams, and it is remembered');
        await click('.sidebar .status-switch .btn[data-mode="team"]');
        await waitFor(`!document.querySelector('.sidebar .status-head') && !!document.querySelector('.sidebar .session-board-card')`, 'the teams', 6000);
        assert.deepEqual((await picture(false)).switchOn, ['Team']);
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await scene(); await waitFor(`!!document.querySelector('.sidebar .status-switch')`, 'the switch in the Team view', 6000);
        assert.deepEqual((await picture(false)).switchOn, ['Team'], 'Team is kept after a reload');
        console.log('computer: the team folds its workers under the orchestrator');
        await ev(`(() => { for (const n of ['ask-407', 'work-409', 'work-410', 'work-411', 'idle-402']) window.__patch(n, { board_project: 'shop' }); for (const s of T.state.liveSessions) if (s.archived) window.__patch(s.name, { board_project: 'shop' }); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        const line = () => ev(`(() => { const row = document.querySelector('.sidebar .session-board-card .session-group-item'); const b = row && row.querySelector('.status-caret-toggle'); const sum = document.querySelector('.sidebar .status-workers-sum'); const dn = document.querySelector('.sidebar .status-workers-done'); return b ? { n: row.querySelector('.status-workers-n').textContent.trim(), open: b.getAttribute('aria-expanded'), sum: sum ? sum.textContent.replace(/\\s+/g, ' ').trim() : null, done: dn ? dn.textContent.replace(/\\s+/g, ' ').trim() : null, rows: document.querySelectorAll('.sidebar .session-board-card .session-group-item').length } : null; })()`);
        const folded = await line();
        assert.equal(folded.n, '5 workers', '"5 workers" is at the right of the orchestrator row');
        assert.equal(folded.sum, '3 working · 1 needs you · 1 ready', 'the line under it, while folded');
        assert.equal(folded.open, 'false'); assert.equal(folded.done, null); assert.equal(folded.rows, 1, 'only the orchestrator row shows while the workers are folded');
        const at = JSON.parse(await ev(`JSON.stringify((() => { const sum = document.querySelector('.sidebar .status-workers-sum'); const row = document.querySelector('.sidebar .session-board-card .session-group-item'); const text = document.createRange(); text.selectNodeContents(sum); return { text: Math.round(text.getBoundingClientRect().left), dot: Math.round(row.querySelector('.session-dot').getBoundingClientRect().left) }; })())`));
        assert.ok(Math.abs(at.text - at.dot) <= 2, `the line under the orchestrator starts under its dot, as the mock has it: ${JSON.stringify(at)}`);
        await shot('team-folded-desktop-1440');
        await click('.sidebar .session-board-card .status-caret-toggle');
        await waitFor(`document.querySelectorAll('.sidebar .session-board-card .session-group-item').length === 6`, 'the workers open', 4000);
        const open = await line();
        assert.equal(open.open, 'true'); assert.equal(open.sum, null, 'the summary line is only for the folded team');
        assert.equal(open.done, '6 done today', 'the open team ends with its archived workers');
        await shot('team-open-desktop-1440');
        await click('.sidebar .status-workers-done button');
        await waitFor(`document.querySelectorAll('.sidebar .session-board-card .session-group-item').length === 12`, 'the six archived workers', 4000); 
        await click('.sidebar .status-workers-done button'); await click('.sidebar .session-board-card .status-caret-toggle');
        await waitFor(`!!document.querySelector('.sidebar .status-workers-sum')`, 'folded again', 4000);
        await click('.sidebar .status-switch .btn[data-mode="status"]');
        await waitFor(`!!document.querySelector('.sidebar .status-head')`, 'Status again', 6000);

        console.log('computer: a question moves an agent to Needs you, an update moves it up');
        await ev(`(() => { window.__patch('work-411', { waiting_for_input: true, staleness_seconds: 5 }); window.__patch('idle-qa', { working: true, staleness_seconds: 0 }); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        p = await picture(false);
        const names = g => p.out.filter(x => x.row && x.group === g).map(x => x.row);
        assert.deepEqual(names('needs'), ['work-411', 'ask-407'], 'a new question is at the top of Needs you');
        assert.equal(names('working')[0] === 'Orchestrator' || names('working')[0] === 'idle-qa', true, 'the agent that came back is among the first of Working');
        assert.equal(names('idle').includes('idle-qa'), false);

        console.log('phone 390: one line counts the rest');
        await ev(`try { localStorage.removeItem('coral-status-more'); localStorage.removeItem('coral-status-folded'); } catch (e) {} true`);
        await load({ width: 390, height: 844, mobile: true });
        await scene(); await waitFor(`!!document.querySelector('#mobile-agent-list .status-head')`, 'the phone groups', 6000);
        p = await picture(true);
        assert.deepEqual(p.out.filter(x => x.row).map(x => x.row), ['ask-407', 'Orchestrator', 'work-409'], 'the agent that needs you and two that are working');
        assert.equal(p.out.find(x => x.more).more, '2 more working · 3 idle · 6 done today');
        assert.ok(p.overflow <= 0, `no horizontal overflow: ${p.overflow}`);
        await shot('status-phone-390');
        await click('#mobile-agent-list .status-more-toggle');
        await waitFor(`document.querySelectorAll('#mobile-agent-list .session-group-item[data-group="__status__"]').length === 14`, 'every agent', 4000);
        await shot('status-phone-390-all');
        console.log('phone 390: the Team view says the same, folded');
        await ev(`(() => { for (const n of ['ask-407', 'work-409', 'work-410', 'work-411', 'idle-402']) window.__patch(n, { board_project: 'shop' }); return true; })()`);
        await click('.status-switch-phone .btn[data-mode="team"]');
        await waitFor(`!!document.querySelector('#mobile-agent-list .status-workers-sum')`, 'the folded line on the phone', 6000);
        assert.equal(await ev(`document.querySelector('#mobile-agent-list .status-workers-sum').textContent.replace(/\\s+/g, ' ').trim()`), '3 working · 1 needs you · 1 ready');
        await shot('team-phone-390');
        console.log('ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
