// The Health check tab of Team settings (#4230), against the real server's step 2 API (be-4175): the tab and its keyboard order, every control
// labelled, the limits as the inputs' limits, the defaults, saving through the real PUT (and what the server stored), a number out of range
// refused before any request, a rule's switch disabling its numbers, Reset to defaults not saving by itself, unsaved changes guarded, the main
// Save bar hidden on this tab, a server refusal shown in words, no tab when the GET leaves "health" out (through Coral Hub), the held-delivery
// card when the server returns held_notice, and no sideways scroll on a phone or at 200% text. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a layout and a redraw settle over frames; there is no completion event
    const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code, windowsVirtualKeyCode: vk }); };
    const ok = name => console.log(`   ✓ ${name}`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const TEAM = 'health-team-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); // one board per run: a repeat on the same server (--stress) must not see the last run's saved recipient
    const P = `#team-settings-health`;
    const api = (path, opts) => ev(`fetch('/api/board/${TEAM}${path}', ${JSON.stringify(opts || {})}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        // A team with two members, through the real API.
        for (const [id, title] of [['Boss', 'Orchestrator'], ['Dev One', 'Developer']]) {
            const r = await api('/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: id, job_title: title, session_name: id.toLowerCase().replace(' ', '-') + '-session' }) });
            assert.ok(r.status < 300, `subscribe ${id}: ${JSON.stringify(r)}`);
        }
        const open = async () => {
            await ev(`window.__h = n => document.querySelector('#team-settings-health [name="' + n + '"]'); window.__fire = (n, v) => { const e = window.__h(n); if (e.type === 'checkbox') e.checked = v; else e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }; true`);
            await ev(`document.getElementById('team-settings-workspace')?.remove(); import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) })); true`);
            await waitFor(`!!document.querySelector('#team-settings-workspace .settings-tab[data-section=health]')`, 'the Health check tab', 15000);
            await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the page loaded', 15000);
            await waitFor(`!!document.querySelector('#team-settings-workspace .settings-tab[data-section=messaging]')`, 'the Messaging tab (drawn after the board\'s cross-team state is read, #5516)', 15000); // so the tab order read below is the settled one
        };
        // The dialog can be drawn again after the Health check tab first appears (the page's settings arrive after it): a click at that instant finds no tab (null),
        // or lands on the one about to be replaced, and the panel's form is drawn only after the board's settings are read, so a read of it straight after finds null. So click in the same evaluation that finds the tab, until the panel and its form are showing (#4992: TypeError null.click and null.elements, ~10%).
        const clickHealthTab = () => waitFor(`(() => { const t = document.querySelector('#team-settings-workspace .settings-tab[data-section=health]'); if (!t) return false; t.click(); const p = document.getElementById('team-settings-health'); return !!p && !p.hidden && !!p.querySelector('[name=on]'); })()`, 'the Health check tab clicked and its panel and fields showing', 15000);
        await open();

        // 1. the tab: named, in the tablist, panel linked, roving order includes it
        const tab = await ev(`(() => { const t = document.querySelector('#team-settings-workspace .settings-tab[data-section=health]'); const p = document.getElementById(t.getAttribute('aria-controls')); return { role: t.getAttribute('role'), text: t.querySelector('.settings-tab-name').textContent, ctl: !!p, panelRole: p.getAttribute('role'), labelled: p.getAttribute('aria-labelledby') === t.id, tabIndex: t.tabIndex, hidden: p.hidden, order: [...document.querySelectorAll('#team-settings-workspace [role=tablist] [role=tab]')].map(x => x.dataset.section) }; })()`);
        assert.deepEqual(tab, { role: 'tab', text: 'Health check', ctl: true, panelRole: 'tabpanel', labelled: true, tabIndex: -1, hidden: true, order: ['workflow', 'health', 'messaging', 'prompts'] });
        await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=workflow]').focus(); true`);
        await key('ArrowDown', 'ArrowDown', 40);
        assert.equal(await ev(`document.activeElement.dataset.section`), 'health', 'ArrowDown from Workflow reaches Health check');
        await key('Home', 'Home', 36); await key('End', 'End', 35);
        assert.equal(await ev(`document.activeElement.dataset.section`), 'prompts', 'End reaches the last tab, Prompts');
        await clickHealthTab();
        const shown = await ev(`(() => ({ panel: !document.getElementById('team-settings-health').closest('.settings-pane').hidden, bar: !!document.querySelector('#team-settings-workspace .sv-save')?.getClientRects().length }))()`);
        assert.deepEqual(shown, { panel: true, bar: true });
        ok('a Health check group after Workflow, reached by the arrow keys; the page\'s one Save bar is there and holds the health check\'s change');

        // 2. defaults, labels and the server's limits as the inputs' limits
        const form = await ev(`(() => { const f = document.querySelector('${P}'); const v = n => window.__h(n); const nums = [...f.querySelectorAll('input[type=number]')].map(i => [i.name, i.value, i.min, i.max]);
            const unlabelled = [...f.querySelectorAll('input, select')].filter(e => !((e.labels && e.labels.length) || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby'))).map(e => e.name);
            return { on: v('on').checked, allClear: v('all_clear').checked, rcpt: v('recipient').value, opts: [...v('recipient').options].map(o => o.value + '=' + o.textContent), nums, unlabelled, rev: v('default_reviewers').value, rules: ['auto_delegate', 'claim_nudge', 'status_nudge', 'mention_renudge', 'busy_no_task', 'post_no_task', 'upload_no_task', 'goal_size'].map(r => v(r + '_on').checked), order: [...f.querySelectorAll('.sv-row')].map(r => r.dataset.key).filter(k => /^(mention_renudge|health_offbooks|busy_no_task|post_no_task|upload_no_task|goal_size)/.test(k)), held: !!v('held_notice_on'), save: document.querySelector('#team-settings-workspace .sv-save').disabled }; })()`);
        assert.equal(form.on, false, 'a new team has the check off (#4962)'); assert.equal(form.allClear, true); assert.equal(form.rcpt, '');
        assert.deepEqual(form.nums, [['interval_min', '10', '5', '1440'], ['claim_nudge_after_min', '10', '5', '1440'], ['claim_nudge_nudges', '2', '1', '5'], ['status_nudge_after_min', '20', '5', '1440'], ['status_nudge_escalate_after_min', '10', '5', '1440'], ['held_notice_after_min', '10', '5', '1440'], ['mention_renudge_after_min', '10', '5', '1440'], ['busy_no_task_after_min', '10', '5', '1440'], ['goal_size_limit', '15', '5', '500'], ['landing_wait_min', '120', '15', '10080'], ['ask_reminder_after_min', '15', '5', '1440']]); // the server returns held_notice since Lead's #4225: its card is in the defaults
        assert.deepEqual(form.unlabelled, [], 'every control has a label');
        assert.deepEqual(form.rules, [true, true, true, true, true, true, true, true], 'the off-the-books signals and the goal-size line are on by default (#7793, #7808)');
        assert.deepEqual(form.order, ['mention_renudge_on', 'mention_renudge_after_min', 'health_offbooks', 'busy_no_task_on', 'busy_no_task_after_min', 'post_no_task_on', 'upload_no_task_on', 'goal_size_on', 'goal_size_limit'], 'under Automatic rules, after the mention reminder, the four signals under their own heading');
        const look = await ev(`(() => { const f = document.querySelector('${P}'); const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; const nums = [...f.querySelectorAll('.sv-row-number input.sv-input')].filter(i => i.getClientRects().length); return { heading: f.querySelector('[data-key=health_offbooks] .sv-heading').textContent, widths: [...new Set(nums.map(i => Math.round(i.getBoundingClientRect().width)))], rem, lefts: [...new Set(nums.map(i => Math.round(i.getBoundingClientRect().left)))], unitsAfter: nums.every(i => i.nextElementSibling && i.nextElementSibling.classList.contains('sv-unit')), count: nums.length, upload: f.querySelector('[data-key=upload_no_task_on] .sv-help').textContent }; })()`);
        assert.equal(look.heading, 'Work done off the books');
        assert.deepEqual(look.widths, [Math.round(6 * look.rem)], `every number box is a fixed 6 rem wide (${JSON.stringify(look)})`);
        assert.equal(look.lefts.length, 1, `the boxes line up at one left edge: ${JSON.stringify(look.lefts)}`); assert.ok(look.unitsAfter && look.count >= 8, 'each unit is after its box');
        assert.ok(!/--no-task/.test(look.upload) && /not marked as having no task/.test(look.upload), `the upload rule's hint has no command flag: ${look.upload}`);
        assert.ok(form.opts.some(o => o.startsWith('Boss=')) && form.opts.some(o => o.startsWith('Dev One=')) && form.opts[0] === '=The orchestrator (default)', JSON.stringify(form.opts));
        assert.equal(form.held, true, 'the held-delivery rule shows: the server returns held_notice (#4225)');
        assert.equal(form.save, true, 'Save starts disabled');
        ok('defaults from the server, limits 5 to 1440 minutes and 1 to 5 nudges on the inputs, every control labelled, members offered as recipients');
        await ev(`document.querySelector('${P} [data-key=busy_no_task_on]')?.scrollIntoView({ block: 'center' }); true`);
        await shot('health-rules-1280');
        // The fields' accessible names and descriptions as the browser computes them (#5790: the number boxes and the reviewers box come from field_row.js): the label and the unit name a number, the limits describe it.
        await waitFor(`!!document.querySelector('${P} [name=claim_nudge_after_min]')?.getClientRects().length`, 'the rules showing', 5000);
        const axNodes = (await client.Accessibility.getFullAXTree()).nodes.filter(n => !n.ignored && ['spinbutton', 'combobox', 'textbox'].includes(n.role && n.role.value));
        const axPairs = axNodes.map(n => [n.name && n.name.value, n.description && n.description.value]).filter(([name]) => name);
        assert.deepEqual(axPairs.filter(([name]) => /min|nudges|^Default reviewers$|tasks in a goal/.test(name)).map(([name, d]) => [name, /^Names of agents/.test(d) ? 'Names of agents' : d]), [
            ['Check every minutes', '5 to 1440'], ['Default reviewers', 'Names of agents'], ['After minutes idle', '5 to 1440'], ['Nudges before telling the orchestrator nudges', '1 to 5'],
            ['Ask after minutes quiet', '5 to 1440'], ['Tell the orchestrator minutes later', '5 to 1440'], ['After minutes held', '5 to 1440'], ['Remind the orchestrator after minutes', '5 to 1440'], ['Working with no task for minutes', '5 to 1440'], ['More than tasks in a goal', '5 to 500'], ['Wait minutes', '15 to 10080'], ['Remind the member after minutes', '5 to 1440']]);
        ok('every number box is named by its label and unit and described by its limits; the reviewers box by its label, described by its sentence');

        // 3. an out-of-range number is refused before any request
        await ev(`window.__puts = 0; { const w = window.fetch; window.fetch = (u, o = {}) => { if ((o.method || 'GET') === 'PUT' && /board\\/[^/]+\\/settings$/.test(String(u))) window.__puts++; return w(u, o); }; } true`);
        await ev(`{ if (!window.__h('on').checked) window.__fire('on', true); /* the number is live only while the check is on */ window.__fire('interval_min', '4'); document.querySelector('#team-settings-workspace .sv-save').click(); } true`);
        const bad = await ev(`({ text: document.querySelector('${P} .sv-row[data-key=interval_min] .sv-error').textContent, focus: document.activeElement.name, err: document.querySelector('${P} [name=interval_min]').getAttribute('aria-invalid'), puts: window.__puts })`);
        assert.match(bad.text, /Check every: use a whole number from 5 to 1440/); assert.equal(bad.focus, 'interval_min'); assert.equal(bad.err, 'true'); assert.equal(bad.puts, 0);
        ok('4 minutes is refused in words, focus goes to the field, and nothing is sent');

        // 4. save through the real PUT; the server's stored copy
        await ev(`{ window.__fire('interval_min', '15'); window.__fire('recipient', 'Dev One'); window.__fire('claim_nudge_on', false); window.__fire('default_reviewers', 'Boss, Dev One, Boss'); window.__fire('busy_no_task_after_min', '25'); window.__fire('post_no_task_on', false); window.__fire('goal_size_on', false); } true`);
        assert.equal(await ev(`window.__h('goal_size_limit').disabled`), true, 'the goal-size limit is live only while its switch is on');
        await ev(`{ window.__fire('goal_size_on', true); window.__fire('goal_size_limit', '30'); } true`);
        assert.equal(await ev(`window.__h('goal_size_limit').disabled`), false);
        await ev(`window.__fire('busy_no_task_on', false); true`);
        assert.equal(await ev(`window.__h('busy_no_task_after_min').disabled`), true, 'a rule that is off disables its minutes');
        await ev(`window.__fire('busy_no_task_on', true); true`);
        const rule = await ev(`(() => ({ disabled: ['claim_nudge_after_min', 'claim_nudge_nudges'].every(n => window.__h(n).disabled), save: document.querySelector('#team-settings-workspace .sv-save').disabled }))()`);
        assert.deepEqual([rule.disabled, rule.save], [true, false], 'a rule that is off disables its numbers; a change enables Save');
        const unsaved = await ev(`import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.hasUnsavedTeamSettings())`);
        assert.equal(unsaved, true, 'unsaved health changes are guarded when leaving');
        await ev(`document.querySelector('#team-settings-workspace .sv-save').click(); true`);
        await waitFor(`document.querySelector('#team-settings-workspace .sv-status')?.textContent === 'Saved.'`, 'the save', 8000);
        const stored = (await api('/settings')).body.health;
        assert.equal(stored.interval_min, 15); assert.equal(stored.recipient, 'Dev One'); assert.equal(stored.claim_nudge.on, false);
        assert.deepEqual(stored.default_reviewers, ['Boss', 'Dev One'], 'duplicates dropped');
        assert.deepEqual([stored.busy_no_task, stored.post_no_task, stored.upload_no_task, stored.goal_size], [{ on: true, after_min: 25 }, { on: false }, { on: true }, { on: true, limit: 30 }], 'the off-the-books signals and the goal-size line are kept by the server as sent');
        const after = await ev(`(() => ({ interval: window.__h('interval_min').value, rcpt: window.__h('recipient').value, save: document.querySelector('#team-settings-workspace .sv-save').disabled, claimOff: !window.__h('claim_nudge_on').checked }))()`);
        assert.deepEqual(after, { interval: '15', rcpt: 'Dev One', save: true, claimOff: true });
        assert.deepEqual(await ev(`[window.__h('busy_no_task_after_min').value, window.__h('post_no_task_on').checked, window.__h('upload_no_task_on').checked, window.__h('goal_size_limit').value]`), ['25', false, true, '30'], 'the form shows what was kept');
        assert.equal(await ev(`import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.hasUnsavedTeamSettings())`), false, 'saved: nothing unsaved');
        ok('Save sends the PUT, the server keeps it (15 minutes, Dev One, claim nudge off, reviewers de-duplicated), the form shows what was kept, nothing left unsaved');

        // 5. reopening shows the saved values; Reset fills the defaults without saving
        await open(); await clickHealthTab();
        assert.equal(await ev(`window.__h('interval_min').value`), '15', 'a reopened tab shows what was saved');
        assert.equal(await ev(`window.__h('goal_size_limit').value`), '30', 'and the goal-size limit');
        await ev(`window.__puts = 0; [...document.querySelectorAll('${P} button')].find(b => b.textContent === 'Reset to defaults').click(); true`);
        const reset = await ev(`(() => ({ interval: window.__h('interval_min').value, rcpt: window.__h('recipient').value, claimOn: window.__h('claim_nudge_on').checked, save: document.querySelector('#team-settings-workspace .sv-save').disabled, text: document.querySelector('#team-settings-workspace .sv-status').textContent, puts: window.__puts, focus: document.activeElement.name }))()`);
        assert.deepEqual(reset, { interval: '10', rcpt: '', claimOn: true, save: false, text: 'The defaults are filled in. Save to apply them.', puts: 0, focus: 'on' });
        assert.equal((await api('/settings')).body.health.interval_min, 15, 'Reset alone saved nothing');
        ok('a reopened tab shows the saved values; Reset to defaults fills the form, enables Save and saves nothing');

        // 6. a server refusal is shown in words; more than 8 reviewers refused before a request
        await ev(`{ const w = window.fetch; window.fetch = (u, o = {}) => (o.method === 'PUT' && /board\\/[^/]+\\/settings$/.test(String(u))) ? Promise.resolve(new Response(JSON.stringify({ error: 'health.recipient: "Gone" is not a member of this team' }), { status: 400, headers: { 'content-type': 'application/json' } })) : w(u, o); } true`);
        await ev(`window.__fire('interval_min', '12'); document.querySelector('#team-settings-workspace .sv-save').click(); true`);
        await waitFor(`/is not a member of this team/.test(document.querySelector('#team-settings-workspace .sv-status').textContent)`, 'the refusal text', 5000);
        assert.equal(await ev(`document.querySelector('#team-settings-workspace .sv-save').disabled`), false, 'Save is available again after a refusal');
        await ev(`window.__fire('default_reviewers', 'a,b,c,d,e,f,g,h,i'); document.querySelector('#team-settings-workspace .sv-save').click(); true`);
        assert.match(await ev(`document.querySelector('${P} .sv-row[data-key=default_reviewers] .sv-error').textContent`), /at most 8 names/);
        ok('a refusal from the server is shown as its words; nine reviewers are refused before a request');

        // 7. held-delivery card and unknown fields: when the server returns held_notice the card shows and a PUT sends it back
        await open();
        await ev(`{ window.__putBody = null; const w = window.fetch; window.fetch = (u, o = {}) => { const url = String(u);
            if (/board\\/[^/]+\\/settings$/.test(url) && (o.method || 'GET') === 'GET') return w(u, o).then(async r => { const b = await r.json(); b.health.held_notice = { on: true, after_min: 15 }; b.health.future_rule = { on: true, x: 3 }; return new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }); });
            if (/board\\/[^/]+\\/settings$/.test(url) && o.method === 'PUT') { window.__putBody = JSON.parse(o.body); const h = window.__putBody.health; return Promise.resolve(new Response(JSON.stringify({ health: h }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return w(u, o); }; } true`);
        await open(); await clickHealthTab();
        const held = await ev(`(() => { const c = document.querySelector('${P} .sv-row[data-key=held_notice_on]'); const i = window.__h('held_notice_after_min'); return c ? { title: c.querySelector('.sv-label').textContent.trim(), after: i.value, lo: i.min, hi: i.max } : null; })()`);
        assert.deepEqual(held, { title: 'Tell the Operator about a held delivery', after: '15', lo: '5', hi: '1440' });
        await ev(`{ window.__fire('held_notice_after_min', '30'); window.__fire('ask_reminder_after_min', '25'); document.querySelector('#team-settings-workspace .sv-save').click(); } true`);
        await waitFor(`!!window.__putBody`, 'the PUT', 5000);
        const body = await ev(`window.__putBody`);
        assert.equal(body.subscriber_id, 'Operator'); assert.equal(body.health.held_notice.after_min, 30); assert.deepEqual(body.health.future_rule, { on: true, x: 3 }, 'a field the form does not know goes back as it was');
        assert.deepEqual(body.health.ask_reminder, { on: true, after_min: 25 }, 'the question reminder (#7794) is a field: its minutes are saved with the rest');
        // Reset to defaults fills the held card with the design's 10 minutes (Lead's #4225 default).
        await ev(`[...document.querySelectorAll('${P} button')].find(b => b.textContent === 'Reset to defaults').click(); true`);
        assert.equal(await ev(`window.__h('held_notice_after_min').value`), '10', 'the held-delivery default is 10 minutes');
        ok('the held-delivery card appears when the server has held_notice and saves; a field the form does not know is sent back unchanged');

        // 8. through Coral Hub the GET leaves "health" out: no tab
        await ev(`{ const w = window.fetch; window.fetch = (u, o = {}) => (/board\\/[^/]+\\/settings$/.test(String(u)) && (o.method || 'GET') === 'GET') ? w(u, o).then(async r => { const b = await r.json(); delete b.health; return new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }); }) : w(u, o); } true`);
        await ev(`document.getElementById('team-settings-workspace')?.remove(); import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) })); true`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the settings to load', 15000);
        await sleep(400); // sleep-ok: the tab would appear from a late answer, so wait past the load for it not to; no completion event
        assert.equal(await ev(`!!document.querySelector('#team-settings-workspace .settings-tab[data-section=health]') || !!document.getElementById('team-settings-health')`), false);
        ok('no Health check tab when the settings GET has no health (through Coral Hub)');

        // 9. phone and 200% text: no sideways scroll in the panel
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        for (const [label, w, big] of [['phone 390', 390, false], ['phone 390 at 200% text', 390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true });
            await ev(`document.documentElement.style.fontSize = ${big ? "'200%'" : "''"}; true`);
            await open(); await clickHealthTab();
            await sleep(500); // sleep-ok: a layout settles over frames; there is no completion event
            const m = await ev(`(() => { const p = document.getElementById('team-settings-health'); const d = document.querySelector('#team-settings-workspace') || p.parentElement; const over = [...p.querySelectorAll('input, select, button, label')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 1).map(e => e.name || e.className); return { over, panelScroll: [p.scrollWidth, p.clientWidth], dialogScroll: [d.scrollWidth, d.clientWidth] }; })()`);
            assert.deepEqual(m.over, [], `${label}: nothing runs past the screen: ${JSON.stringify(m)}`);
            assert.ok(m.panelScroll[0] <= m.panelScroll[1] + 1, `${label}: no sideways scroll in the panel ${JSON.stringify(m)}`);
            await ev(`document.querySelector('#team-settings-health [data-key=busy_no_task_on]')?.scrollIntoView({ block: 'center' }); true`);
            await shot(`health-rules-${w}${big ? '-200' : ''}`);
            ok(`${label}: no control past the screen edge, no sideways scroll`);
        }
        console.log('\nPASS the Health check tab of Team settings');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
