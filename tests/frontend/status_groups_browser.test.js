// #21466 (the Operator's approved concept mocks v3, idea 4): the agent list grouped by status, the default, with Group by as three check boxes (Computer, Team, Task) in the Display panel, all unticked, whose choice is remembered (#21683, then #21685).
//   1. a fresh profile opens on Status: Needs you, Working, Idle, then Done today, folded; each heading has its count, no row has a status dot, and a group's rows run newest update first;
//   2. Done today opens from its heading with a real click; the choice is kept after a reload;
//   3. the Team button brings back the teams (the orchestrator card), is remembered across a reload, and Status brings the groups back;
//   4. a phone shows every agent that needs you, two working, and one line: "2 more working · 3 idle · 6 done today", which opens the rest;
//   5. an agent that comes back with output moves up (a working agent's update is newer than the others'), and an agent that asks a question moves to Needs you.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { settle, coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect({ grouping: 'status' });
    const { Input } = client;
    const { safePaused } = require('./helpers/paused');
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
            // The page's own first live-list read has to be finished before scene() takes over what the mocked server answers (#21921): a read still in flight answers with the bare rows and lands on the scene after it is drawn (it is the 'every agent' wait that timed out on a starved CI runner)
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded');
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
            return { out, switchOn: [...document.querySelectorAll('fieldset[data-group-by] input[data-box]')].filter(e => e.offsetParent && e.checked).map(e => e.dataset.box), oldSwitch: document.querySelectorAll('.status-switch, .status-switch-phone').length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        })()`);
        const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}-${process.env.LOOK_THEME || 'dark'}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // LOOK_THEME=light|dark picks the theme
        const pick = async (value, hostId) => { // the Team box of Group by in the Display panel, ticked or unticked as a person does ('team' ticks it, 'status' clears it; the panel is kept open)
            await waitFor(`!!document.querySelector('#${hostId} fieldset[data-group-by] input[data-box="team"]')`, 'the Group by boxes', 6000);
            await ev(`(() => { const e = document.querySelector('#${hostId} fieldset[data-group-by] input[data-box="team"]'); if (e.checked !== ${value === 'team'}) e.click(); return true; })()`);
        };
        const click = async sel => { // a real press on the element, once its rectangle is the same on two animation frames in a row (a list that is still moving would be pressed where the row was, #21921), and after checking that it is what is under that point
            const box = JSON.parse(await ev(`(async () => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'null'; e.scrollIntoView({ block: 'center' });
                const rect = () => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(','); };
                let last = rect(), steady = false;
                for (let i = 0; i < 40 && !steady; i++) { await ${framesJs(1)}; const now = rect(); steady = now === last; last = now; }
                const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y);
                return JSON.stringify({ x, y, steady, ok: hit === e || e.contains(hit) }); })()`));
            assert.ok(box && box.steady, `${sel} stops moving before the press (a late element is still pushing the page)`);
            assert.ok(box && box.ok, `${sel} is under its own point`);
            for (const type of ['mousePressed', 'mouseReleased']) await Input.dispatchMouseEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
        };

        console.log('computer: with Team and Task unticked the list is by Status');
        await load({ width: 1440, height: 900, mobile: false });
        await ev(`try { localStorage.removeItem('coral-agent-grouping'); localStorage.setItem('coral-group-team', 'false'); localStorage.setItem('coral-group-task', 'false'); localStorage.setItem('coral_display_panel_open', '1'); } catch (e) {} true`); // a new viewer opens on Team and Task (#22104)
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        assert.equal(await scene(), 14);
        await waitFor(`!!document.querySelector('.sidebar .status-head')`, 'the status groups', 6000);
        await ev(`window._coralLoadLiveSessions().then(() => true)`); // a live-list read that lands after the scene (CI's slower first read): the mocked server answers with the scene, so the list does not change (#21725)
        await waitFor(`!!document.querySelector('.sidebar .status-head')`, 'the groups after the read', 6000);
        let p = await picture(false);
        await ev(`document.querySelector('.sidebar-header')?.scrollIntoView(); true`); await shot('groupby-desktop-1440');
        assert.deepEqual(p.out.filter(x => x.head).map(x => [x.head, x.name, x.n]), [['needs', 'Needs you', 1], ['working', 'Working', 4], ['idle', 'Idle', 3], ['done', 'Done today', 6]], 'the four groups, in order, with their counts');
        assert.deepEqual(p.out.filter(x => x.head).map(x => x.open), ['true', 'true', 'true', 'false'], 'Done today is folded');
        assert.deepEqual(p.out.filter(x => x.row).map(x => x.row), ['ask-407', 'Orchestrator', 'work-409', 'work-410', 'work-411', 'idle-designer', 'idle-402', 'idle-qa'], 'newest update first inside each group');
        assert.ok(p.out.filter(x => x.row).every(x => !x.dot), 'a row has no status dot: its heading is the status');
        assert.equal(p.out.find(x => x.row === 'work-410').time, '2 min');
        assert.deepEqual(p.switchOn, [], 'no Group by box is ticked: the Status view');
        assert.equal(p.oldSwitch, 0, 'no segmented switch is drawn any more');
        const row = JSON.parse(await ev(`(() => { const f = document.querySelector('#agent-list-bar fieldset[data-group-by]'), cnt = document.querySelector('#agent-list-bar .list-bar-count'); return JSON.stringify({ label: f.querySelector('legend').textContent, opts: [...f.querySelectorAll('label')].map(l => l.textContent.trim()), above: !!(cnt.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_PRECEDING) }); })()`));
        assert.deepEqual([row.label, row.opts], ['Group by', ['Computer', 'Team', 'Task']]);
        assert.ok(row.above, 'above the count, with the other display controls ' + JSON.stringify(row));
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
        await pick('team', 'agent-list-bar');
        await waitFor(`!document.querySelector('.sidebar .status-head') && !!document.querySelector('.sidebar .session-board-card')`, 'the teams', 6000);
        assert.deepEqual((await picture(false)).switchOn, ['team']);
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await scene(); await waitFor(`!!document.querySelector('#agent-list-bar fieldset[data-group-by]')`, 'the Group by boxes in the Team view', 6000);
        assert.deepEqual((await picture(false)).switchOn, ['team'], 'Team is kept after a reload');
        console.log('computer: the team folds its workers under the orchestrator');
        await ev(`(() => { for (const n of ['ask-407', 'work-409', 'work-410', 'work-411', 'idle-402']) window.__patch(n, { board_project: 'shop' }); for (const s of T.state.liveSessions) if (s.archived) window.__patch(s.name, { board_project: 'shop' }); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        const ORCH = `.sidebar .session-board-card .session-group-item`;
        const line = () => ev(`(() => { const row = document.querySelector('${ORCH}'); const sum = document.querySelector('.sidebar .status-workers-sum'); const dn = document.querySelector('.sidebar .status-workers-done'); return row && row.hasAttribute('aria-expanded') ? { n: (row.getAttribute('aria-label').match(/, (\\d+ workers)$/) || [])[1], open: row.getAttribute('aria-expanded'), sum: sum ? sum.textContent.replace(/\\s+/g, ' ').trim() : null, done: dn ? dn.textContent.replace(/\\s+/g, ' ').trim() : null, rows: document.querySelectorAll('${ORCH}').length } : null; })()`);
        const folded = await line();
        assert.equal(folded.n, '5 workers', 'the orchestrator row says it has 5 workers');
        assert.equal(folded.sum, '3 working · 1 needs you · 1 ready', 'the line under it, while folded');
        assert.equal(folded.open, 'false'); assert.equal(folded.done, null); assert.equal(folded.rows, 1, 'only the orchestrator row shows while the workers are folded');
        const at = JSON.parse(await ev(`JSON.stringify((() => { const sum = document.querySelector('.sidebar .status-workers-sum'); const row = document.querySelector('.sidebar .session-board-card .session-group-item'); const text = document.createRange(); text.selectNodeContents(sum); return { text: Math.round(text.getBoundingClientRect().left), dot: Math.round(row.querySelector('.session-dot').getBoundingClientRect().left) }; })())`));
        assert.ok(Math.abs(at.text - at.dot) <= 2, `the line under the orchestrator starts under its dot, as the mock has it: ${JSON.stringify(at)}`);
        await shot('team-folded-desktop-1440');
        // #22045: no fold button on the orchestrator row (it was "5 workers" and a chevron, #21686); a click on the row once it is selected opens or closes its workers, the first click only selects it, and Enter on the selected row does the same. aria-expanded is on the row.
        assert.equal(await ev(`document.querySelectorAll('.sidebar .status-workers-toggle, .sidebar .status-workers-n').length`), 0, 'the orchestrator row has no fold button');
        const orch = () => ev(`(() => { const row = document.querySelector('${ORCH}'); return { expanded: row.getAttribute('aria-expanded'), current: row.getAttribute('aria-current'), focused: document.activeElement === row, rows: document.querySelectorAll('${ORCH}').length }; })()`);
        let o = await orch();
        assert.deepEqual([o.expanded, o.current], ['false', null], 'folded and not yet selected: ' + JSON.stringify(o));
        await click(`${ORCH} .session-label`);
        await waitFor(`document.querySelector('${ORCH}').getAttribute('aria-current') === 'true'`, 'the first click selects the Orchestrator', 4000);
        await settle(ev, 300); // sleep-ok: a row click opens the agent through a few async steps
        o = await orch(); assert.deepEqual([o.expanded, o.rows], ['false', 1], 'the first click does not open the workers: ' + JSON.stringify(o));
        await click(`${ORCH} .session-label`);
        await waitFor(`document.querySelectorAll('${ORCH}').length === 6`, 'a click on the selected row opens the workers', 4000);
        o = await orch(); assert.deepEqual([o.expanded, o.current], ['true', 'true'], 'open, and still the selected agent: ' + JSON.stringify(o));
        const press = async k => { const code = k === ' ' ? 'Space' : 'Enter'; for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code, windowsVirtualKeyCode: k === ' ' ? 32 : 13, ...(type === 'keyDown' ? { text: k === ' ' ? ' ' : '\r' } : {}) }); };
        await ev(`document.querySelector('${ORCH}').focus(); true`);
        await press('Enter');
        await waitFor(`!!document.querySelector('.sidebar .status-workers-sum')`, 'Enter on the selected row folds the workers', 4000);
        o = await orch(); assert.deepEqual([o.expanded, o.current, o.rows], ['false', 'true', 1], 'folded by Enter: ' + JSON.stringify(o));
        await ev(`document.querySelector('${ORCH}').focus(); true`);
        await press('Enter');
        await waitFor(`document.querySelectorAll('${ORCH}').length === 6`, 'Enter opens them again', 4000);
        assert.equal((await orch()).expanded, 'true');
        const open = await line();
        assert.equal(open.open, 'true'); assert.equal(open.sum, null, 'the summary line is only for the folded team');
        assert.equal(open.done, '6 done today', 'the open team ends with its archived workers');
        await shot('team-open-desktop-1440');
        await click('.sidebar .status-workers-done button');
        await waitFor(`document.querySelectorAll('.sidebar .session-board-card .session-group-item').length === 12`, 'the six archived workers', 4000); 
        await click('.sidebar .status-workers-done button'); await click(`${ORCH} .session-label`);
        await waitFor(`!!document.querySelector('.sidebar .status-workers-sum')`, 'folded again', 4000);
        await pick('status', 'agent-list-bar');
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
        // The launch notice's read answers late, as on a slow runner (#21921): it came about 70 ms after the list, between a press being aimed and made, and the press landed on a row. It is held here so that every run has that order.
        await client.Fetch.enable({ patterns: [{ urlPattern: '*/api/launch-disclosure', requestStage: 'Request' }] });
        safePaused(client, async e => { if (e.request.method === 'GET') await new Promise(r => setTimeout(r, 400)); await client.Fetch.continueRequest({ requestId: e.requestId }); }); // sleep-ok: simulated latency of one response, not a wait for the page
        await load({ width: 390, height: 844, mobile: true });
        await scene(); await waitFor(`!!document.querySelector('#mobile-agent-list .status-head')`, 'the phone groups', 6000);
        // The launch notice (Auto mode) comes when the first local agent does, which here is the scene, a moment after the list is drawn, and moves the list down by its height: it is part of the page before anything is pressed (#21921)
        await waitFor(`!!document.getElementById('launch-disclosure-banner')`, 'the launch notice, which comes with the first local agent', 6000);
        await shot('groupby-phone-390');
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
        await pick('team', 'mobile-agent-list-bar');
        await waitFor(`!!document.querySelector('#mobile-agent-list .status-workers-sum')`, 'the folded line on the phone', 6000);
        assert.equal(await ev(`document.querySelector('#mobile-agent-list .status-workers-sum').textContent.replace(/\\s+/g, ' ').trim()`), '3 working · 1 needs you · 1 ready');
        const ph = await ev(`(() => { const row = document.querySelector('#mobile-agent-list .session-board-card .session-group-item'); return { button: !!document.querySelector('#mobile-agent-list .status-workers-toggle'), expanded: row.getAttribute('aria-expanded'), label: row.getAttribute('aria-label'), caret: !!document.querySelector('#mobile-agent-list .status-caret') }; })()`);
        assert.ok(!ph.button && ph.expanded === 'false' && / 5 workers$/.test(ph.label) && !ph.caret, 'on the phone the orchestrator row has no fold button; the row carries aria-expanded: ' + JSON.stringify(ph));
        await shot('team-phone-390');
        // #22045 on the phone: a tap on the unselected Orchestrator row opens the agent; back on the list the row is highlighted, and a tap on it then opens or closes its workers (it does not open the agent again).
        const PORCH = '#mobile-agent-list .session-board-card .session-group-item';
        const orchName = await ev(`document.querySelector('${PORCH}').dataset.name`);
        await click(`${PORCH} .session-label`);
        await waitFor(`!!(T.state.currentSession && T.state.currentSession.name === ${JSON.stringify(orchName)})`, 'a tap on the unselected row opens the Orchestrator', 6000);
        await ev(`window.mobileBack(); true`);
        await waitFor(`(() => { const r = document.querySelector('${PORCH}'); return !!r && r.getClientRects().length > 0 && r.classList.contains('active'); })()`, 'back on the list, the Orchestrator row is the selected one', 6000);
        const hl = JSON.parse(await ev(`JSON.stringify((() => { const rows = [...document.querySelectorAll('#mobile-agent-list .session-group-item')].filter(r => r.getClientRects().length); const sel = rows.find(r => r.classList.contains('active')), other = rows.find(r => !r.classList.contains('active')); const look = r => r && (getComputedStyle(r).backgroundColor + '|' + getComputedStyle(r).boxShadow); return { expanded: sel && sel.getAttribute('aria-expanded'), sel: look(sel), other: look(other), rows: rows.length }; })())`));
        assert.ok(hl.other && hl.sel !== hl.other && hl.expanded === 'false', 'the selected Orchestrator row looks different from an unselected one on the 390 list, so the next tap is not a surprise: ' + JSON.stringify(hl));
        await shot('team-phone-390-selected');
        await click(`${PORCH} .session-label`);
        await waitFor(`document.querySelectorAll('${PORCH}').length === 6`, 'a tap on the selected row opens its workers', 4000);
        assert.deepEqual(await ev(`(() => { const r = document.querySelector('${PORCH}'); return [r.getAttribute('aria-expanded'), r.classList.contains('active'), r.getClientRects().length > 0]; })()`), ['true', true, true], 'the workers are open, the row stays selected and the list stays on screen');
        await shot('team-phone-390-open');
        await click(`${PORCH} .session-label`);
        await waitFor(`!!document.querySelector('#mobile-agent-list .status-workers-sum')`, 'a second tap folds them again', 4000);
        console.log('ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
