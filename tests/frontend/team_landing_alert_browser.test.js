// The Landing alert of the team's Health check (#8967, Goal #80, the server's #8947): a switch, off by default; on, it has a Branch, a Wait in minutes and an Also tell picker (blank: only the orchestrator). A branch the server
// would not read and a wait outside 15 to 10080 are refused in words at the field before any request; a value the server refuses (a member who is not on the team) is shown at its field as well as in the bar; a valid
// setting is saved through the real PUT and read back. Real board on the isolated dev server (removed again). 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const RUN = 'land-' + Date.now().toString(36), made = [];
    let TEAM = RUN;
    const P = '#team-settings-health';
    const api = (path, opts) => ev(`fetch('/api/board/${TEAM}${path}', ${JSON.stringify(opts || {})}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const h = n => `document.querySelector('${P} [name="${n}"]')`;
    const fire = (n, v) => ev(`(() => { const e = ${h(n)}; if (e.type === 'checkbox') e.checked = ${JSON.stringify(v)}; else e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const rowError = k => ev(`(document.querySelector('${P} .sv-row[data-key=${k}] .sv-error') || {}).textContent || ''`);
    const save = () => ev(`document.querySelector('#team-settings-workspace .sv-save').click(); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        for (const [w, hgt, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            TEAM = RUN + '-' + w; made.push(TEAM); // a board of its own per width: the last one's saved alert is not this one's default
            for (const [id, title] of [['Boss', 'Orchestrator'], ['Dev One', 'Developer']]) {
                const r = await api('/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: id, job_title: title, session_name: id.toLowerCase().replace(' ', '-') + '-session' }) });
                assert.ok(r.status < 300, `subscribe ${id}: ${JSON.stringify(r)}`);
            }
            await Emulation.setDeviceMetricsOverride({ width: w, height: hgt, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            console.log(`${at}the Landing alert fields`);
            await ev(`document.getElementById('team-settings-workspace')?.remove(); import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) })); true`);
            await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]') && !!document.querySelector('#team-settings-workspace .settings-tab[data-section=messaging]')`, 'the settings page', 15000);
            await waitFor(`(() => { const t = document.querySelector('#team-settings-workspace .settings-tab[data-section=health]'); if (!t) return false; t.click(); const p = document.querySelector('${P}'); return !!p && !p.closest('.settings-pane').hidden && !!document.querySelector('${P} [name=landing_on]'); })()`, 'the Health check group with the Landing alert', 15000);
            const form = await ev(`(() => ({ on: ${h('landing_on')}.checked, branch: ${h('landing_branch')}.value, wait: ${h('landing_wait_min')}.value, min: ${h('landing_wait_min')}.min, max: ${h('landing_wait_min')}.max, dis: ['landing_branch', 'landing_wait_min', 'landing_nudge'].map(n => document.querySelector('${P} [name=' + n + ']').disabled), opts: [...document.querySelector('${P} [name=landing_nudge]').options].map(o => o.value), unlabelled: ['landing_on', 'landing_branch', 'landing_wait_min', 'landing_nudge'].filter(n => { const e = document.querySelector('${P} [name=' + n + ']'); return !((e.labels && e.labels.length) || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby')); }) }))()`);
            assert.equal(form.on, false, at + 'off by default'); assert.equal(form.branch, 'main'); assert.equal(form.wait, '120'); assert.deepEqual([form.min, form.max], ['15', '10080']);
            assert.deepEqual(form.dis, [true, true, true], at + 'the fields are live only while the switch is on'); assert.deepEqual(form.opts, ['', 'Boss', 'Dev One'], at + 'blank first, then the members'); assert.deepEqual(form.unlabelled, [], at + 'every control is labelled');

            console.log(`${at}a value the server would not read is refused at its field, before any request`);
            await ev(`window.__puts = 0; if (!window.__wrapped) { window.__wrapped = true; const w = window.fetch; window.fetch = (u, o = {}) => { if ((o.method || 'GET') === 'PUT' && /board\\/[^/]+\\/settings$/.test(String(u))) window.__puts++; return w(u, o); }; } true`);
            await fire('landing_on', true);
            assert.equal(await ev(`${h('landing_branch')}.disabled`), false, at + 'the switch makes the fields live');
            await fire('landing_branch', '../x'); await fire('landing_wait_min', '10'); await save();
            await waitFor(`(document.querySelector('${P} .sv-row[data-key=landing_branch] .sv-error') || {}).textContent`, 'the branch refusal', 5000);
            assert.match(await rowError('landing_branch'), /is not a branch name Coral reads/, at + 'the branch is refused in the server\'s words');
            assert.match(await rowError('landing_wait_min'), /15 to 10080/, at + 'the wait is refused with its range');
            assert.equal(await ev(`window.__puts`), 0, at + 'nothing was sent');

            console.log(`${at}a valid setting is saved and read back`);
            await fire('landing_branch', 'release/1.x'); await fire('landing_wait_min', '60'); await fire('landing_nudge', 'Dev One'); await save();
            await waitFor(`window.__puts >= 1`, 'the save', 8000);
            let stored;
            for (let i = 0; i < 30 && !(stored && stored.on && stored.nudge); i++) { stored = ((await api('/settings')).body || {}).health?.landing; if (!(stored && stored.on && stored.nudge)) await new Promise(r => setTimeout(r, 200)); } // sleep-ok: the PUT lands a frame after the click
            assert.deepEqual(stored, { on: true, branch: 'release/1.x', wait_min: 60, nudge: 'Dev One' }, at + 'what the server kept');
            await shot(`landing-alert-${w}`);

            console.log(`${at}a refusal from the server is shown at its field`);
            await ev(`{ const s = ${h('landing_nudge')}; s.append(Object.assign(document.createElement('option'), { value: 'Ghost', textContent: 'Ghost' })); } true`);
            await fire('landing_nudge', 'Ghost'); await save();
            await waitFor(`/not a member/.test((document.querySelector('${P} .sv-row[data-key=landing_nudge] .sv-error') || {}).textContent || '')`, 'the refusal at the field', 8000);
            assert.match(await ev(`document.querySelector('#team-settings-workspace .sv-status').textContent`), /not a member|Could not save/, at + 'and in the bar');
            await shot(`landing-alert-refused-${w}`);

            console.log(`${at}goals ready to close and open tasks with no goal or assignee (#9006)`);
            await fire('landing_nudge', ''); // the refused member from above is not wanted any more
            const defs = await ev(`(() => { const g = n => document.querySelector('${P} [name=' + n + ']'); return { gOn: g('goals_ready_on').checked, gWait: g('goals_ready_wait_min').value, gRange: [g('goals_ready_wait_min').min, g('goals_ready_wait_min').max], uOn: g('unowned_tasks_on').checked, uWait: g('unowned_tasks_wait_min').value, hints: [...document.querySelectorAll('${P} .sv-row[data-key=landing_wait_min] .sv-help, ${P} .sv-row[data-key=goals_ready_wait_min] .sv-help')].map(e => e.textContent.trim()), opts: [...g('unowned_tasks_nudge').options].map(o => o.value), unlabelled: ['goals_ready_on', 'goals_ready_wait_min', 'goals_ready_nudge', 'unowned_tasks_on', 'unowned_tasks_wait_min', 'unowned_tasks_nudge'].filter(n => { const e = g(n); return !((e.labels && e.labels.length) || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby')); }) }; })()`);
            assert.deepEqual([defs.gOn, defs.gWait, defs.uOn, defs.uWait], [true, '30', true, '15'], at + 'both on by default, 30 and 15 minutes'); assert.deepEqual(defs.gRange, ['5', '10080']);
            assert.deepEqual(defs.hints, ['15 minutes to 7 days', '5 minutes to 7 days'], at + 'the wait says its range in words'); assert.deepEqual(defs.opts, ['', 'Boss', 'Dev One']); assert.deepEqual(defs.unlabelled, []);
            await fire('goals_ready_wait_min', '4'); await save();
            await waitFor(`/5 to 10080/.test((document.querySelector('${P} .sv-row[data-key=goals_ready_wait_min] .sv-error') || {}).textContent || '')`, 'the goals-ready range refusal', 5000);
            await fire('goals_ready_wait_min', '45'); await fire('goals_ready_nudge', 'Dev One'); await fire('unowned_tasks_on', false); await fire('unowned_tasks_wait_min', '20'); await save();
            let kept;
            for (let i = 0; i < 30 && !(kept && kept.goals_ready && kept.goals_ready.nudge); i++) { kept = ((await api('/settings')).body || {}).health; if (!(kept && kept.goals_ready && kept.goals_ready.nudge)) await new Promise(r => setTimeout(r, 200)); } // sleep-ok: the PUT lands a frame after the click
            assert.deepEqual([kept.goals_ready, kept.unowned_tasks], [{ on: true, wait_min: 45, nudge: 'Dev One' }, { on: false, wait_min: 20, nudge: '' }], at + 'what the server kept');
            await ev(`{ const s = document.querySelector('${P} [name=unowned_tasks_nudge]'); s.append(Object.assign(document.createElement('option'), { value: 'Ghost', textContent: 'Ghost' })); } true`);
            await fire('unowned_tasks_on', true); await fire('unowned_tasks_nudge', 'Ghost'); await save();
            await waitFor(`/not a member/.test((document.querySelector('${P} .sv-row[data-key=unowned_tasks_nudge] .sv-error') || {}).textContent || '')`, 'the unowned-tasks refusal at its field', 8000);
            await shot(`health-wait-checks-${w}`);
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, at + 'no sideways scroll');
            console.log('   ✓');
        }
        console.log('PASS landing alert: off by default, Branch, Wait and Also tell, refused at the field in words, saved through the real PUT');
    } finally { await removeBoards(ev, made).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
