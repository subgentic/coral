// The New job form (#6540 mock, #6578): Name, Workflow and When first; the schedule preview is one sentence; Description, Time zone and Time limit sit behind "More options"; the time limit is
// a number with a unit; an agent job's branch, flags and cleanup are behind More options too; with no workflow the field says so and offers to make one. Errors are in words and on the field.
// 1280 and 390 px, both themes for contrast. The workflow list and the save are stood in at the page's fetch; the schedule check is the real server's.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => {
    const real = window.fetch; window.__saved = []; window.__wf = [{ id: 7, name: 'nightly-build', description: 'Build and test' }];
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/workflows' && m === 'GET') return json({ workflows: window.__wf });
        if (p === '/api/scheduled/jobs' && m === 'POST') { window.__saved.push(JSON.parse(o.body)); return json({ id: 99 }); }
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const type = async (sel, text) => { await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select && e.select(); return true; })()`); await Input.insertText({ text }); };
    const errorOf = id => `document.getElementById('${id}').closest('.sv-row').querySelector('.sv-error')`;
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility(); })()`; // checkVisibility: a closed disclosure's contents count as not shown
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile }); await Emulation.setTimezoneOverride({ timezoneId: 'Europe/Berlin' }); // the person's own zone is what a schedule is read in
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev); await ev(STUB);
            await ev(`window.showJobModal().then(() => true)`); // the form loads on first use (#10218): showJobModal answers once it is open
            await waitFor(`document.querySelectorAll('#job-modal-workflow option').length === 2`, 'the workflow list', 8000);
            await waitFor(`/Runs every day at 09:00/.test(document.getElementById('cron-preview').textContent)`, 'the preview', 8000);
            await installAudit(ev);

            // 1. what is on the form first
            assert.equal(await ev(vis('#job-modal-name')), true, at + 'Name');
            assert.equal(await ev(vis('#job-modal-workflow')), true, at + 'Workflow');
            for (const id of ['#job-modal-description', '#job-modal-timezone', '#job-modal-timeout', '#job-modal-cleanup', '#job-modal-cron']) assert.equal(await ev(vis(id)), false, at + id + ' is not on the first screen');
            const labels = await ev(`[...document.querySelectorAll('#job-form .sv-row')].filter(r => r.checkVisibility()).map(r => r.querySelector('.sv-label').textContent.trim() + '|' + (r.querySelector('.sv-required') ? 'req' : ''))`);
            assert.deepEqual(labels, ['Type|', 'Name|req', 'When|req', 'Workflow|req'], at + 'labels, in order (When right after Name, #9965), with Required in words: ' + JSON.stringify(labels));
            assert.deepEqual(await ev(`[...document.querySelectorAll('.sched-preset')].map(b => b.textContent.trim())`), ['Every N minutes', 'Every N hours', 'Daily at', 'Weekly on', 'Advanced'], at + 'the schedule is picked: minutes, hours, daily, weekly; the cron box is Advanced');
            const prev = await ev(`document.getElementById('cron-preview').textContent`);
            assert.match(prev, /^Runs every day at 09:00\. Next: (today|tomorrow) 09:00\.$/, at + 'the preview is one sentence, in the person\'s own zone (no zone named): ' + prev);
            assert.equal(await ev(`document.getElementById('cron-preview').getAttribute('role')`), 'status');
            assert.equal(await ev(`document.getElementById('job-modal-more').open`), false, at + 'More options starts closed');
            await ev(`document.querySelector('.sched-preset:nth-child(3)').click(); true`);
            // only the chosen preset looks chosen, right after the click (no fade from the one before), and a hover or focus is not the chosen look
            const looks = await ev(`[...document.querySelectorAll('.sched-preset')].map(b => getComputedStyle(b).backgroundColor)`);
            const chosen = looks[2];
            assert.deepEqual(looks.map((c, i) => c === chosen && i !== 2), [false, false, false, false, false], at + 'no other preset has the chosen preset\'s fill: ' + JSON.stringify(looks));
            assert.deepEqual(await ev(`[...document.querySelectorAll('.sched-preset')].map(b => b.getAttribute('aria-pressed'))`), ['false', 'false', 'true', 'false', 'false'], at + 'and only one is pressed');
            // the dialog's pattern: no Close X (Cancel and Escape close it, #9456), the buttons at the bottom right
            const pat = await ev(`(() => { const m = document.querySelector('#job-modal .modal-content').getBoundingClientRect(), f = document.getElementById('job-modal-submit').getBoundingClientRect(); return { hasX: !!document.querySelector('#job-modal .modal-close-btn'), btnRight: Math.round(m.right - f.right) }; })()`);
            assert.equal(pat.hasX, false, at + 'New job has no Close X');
            assert.ok(pat.btnRight <= 40, at + 'the buttons are at the bottom right: ' + JSON.stringify(pat));
            await waitFor(`/every day at 09:00/.test(document.getElementById('cron-preview').textContent)`, 'daily preview', 8000);
            await shot(`job-form-${w}`);

            // 2. contrast, both themes
            for (const theme of ['dark', 'light']) {
                await setTheme(ev, theme);
                const c = await auditRegion(ev, ['#job-modal .modal-content']);
                assert.ok(c.checked && !c.fails.length, at + theme + ' contrast: ' + JSON.stringify(c.fails));
            }
            await setTheme(ev, 'dark');

            // 3. phone: no sideways scroll; the field's left edge is the 16 px gutter of the dialog, not a wide margin
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, at + 'no sideways scroll');
            if (mobile) {
                const edge = await ev(`Math.round(document.getElementById('job-modal-name').getBoundingClientRect().left)`);
                assert.ok(edge <= 28, at + 'the fields start close to the edge (a 16 px gutter plus the dialog border): left edge ' + edge);
            }

            // 3b. the pickers write the cron expression; the zone defaults to the person's own and is not named
            const cronOf = () => ev(`document.getElementById('job-modal-cron').value`);
            await ev(`document.querySelector('.sched-preset[data-mode="minutes"]').click(); true`);
            await ev(`(() => { const s = document.getElementById('job-modal-every'); s.value = '15'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            assert.equal(await cronOf(), '*/15 * * * *', at + 'every 15 minutes');
            await waitFor(`/^Runs every 15 minutes\\. Next:/.test(document.getElementById('cron-preview').textContent)`, 'the sentence for every 15 minutes', 8000);
            await ev(`document.querySelector('.sched-preset[data-mode="hours"]').click(); true`);
            await ev(`(() => { const s = document.getElementById('job-modal-every'); s.value = '6'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#job-modal-every option')].map(o => o.value).join(',')`), '1,2,3,4,6,8,12', at + 'hours offer only the steps that divide the day');
            assert.equal(await cronOf(), '0 */6 * * *', at + 'every 6 hours');
            await ev(`document.querySelector('.sched-preset[data-mode="daily"]').click(); true`);
            await ev(`(() => { const i = document.getElementById('job-modal-at'); i.value = '07:30'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            assert.equal(await cronOf(), '30 7 * * *', at + 'daily at 07:30');
            await ev(`document.querySelector('.sched-preset[data-mode="weekly"]').click(); true`);
            assert.equal(await cronOf(), '30 7 * * 1', at + 'weekly starts with Monday');
            await ev(`document.querySelector('.sched-day[data-day="3"]').click(); true`);
            assert.equal(await cronOf(), '30 7 * * 1,3', at + 'Monday and Wednesday at 07:30');
            await waitFor(`/^Runs at 07:30, Mondays and Wednesdays\\./.test(document.getElementById('cron-preview').textContent)`, 'the weekly sentence', 8000);
            assert.equal(await ev(`document.getElementById('job-modal-timezone').value`), 'Europe/Berlin', at + 'the zone is the person\'s own by default');
            await shot(`job-form-weekly-${w}`);

            // 4. Advanced draws the cron field, with its words
            await ev(`document.querySelector('.sched-preset[data-mode="cron"]').click(); true`);
            assert.equal(await ev(vis('#job-modal-cron')), true, at + 'Advanced shows the cron field');
            assert.equal(await ev(`document.getElementById('job-modal-cron').closest('label').firstChild.textContent.trim()`), 'Cron expression');
            await type('#job-modal-cron', 'nonsense');
            await waitFor(`/not a schedule Coral can read/.test(document.getElementById('cron-preview').textContent)`, 'a bad schedule in words', 8000);
            await shot(`job-form-custom-${w}`);
            await type('#job-modal-cron', '0 5 * * 1,3');
            await waitFor(`/Runs at 05:00, Mondays and Wednesdays\\./.test(document.getElementById('cron-preview').textContent)`, 'a less common shape is said in words (#6956)', 8000);

            // 5. More options: time limit and zone in words
            await ev(`document.querySelector('#job-modal-more > summary').click(); true`);
            assert.equal(await ev(vis('#job-modal-timeout')), true, at + 'More options shows the time limit');
            assert.equal(await ev(`document.getElementById('job-modal-timeout').value + ' ' + document.getElementById('job-modal-timeout-unit').selectedOptions[0].textContent`), '1 hours', at + 'the default is 1 hour');
            assert.equal(await ev(vis('#job-modal-cleanup')), false, at + 'a workflow job has no cleanup choice');
            await type('#job-modal-timeout', '0');
            assert.match(await ev(`${errorOf('job-modal-limit')}.textContent`), /whole number of one or more/, at + 'zero, in words');
            await ev(`(() => { const u = document.getElementById('job-modal-timeout-unit'); u.value = '1'; u.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await type('#job-modal-timeout', '30');
            assert.match(await ev(`${errorOf('job-modal-limit')}.textContent`), /at least 1 minute/, at + '30 seconds, in words');
            assert.equal(await ev(`document.getElementById('job-modal-timeout').getAttribute('aria-invalid')`), 'true');
            await type('#job-modal-timeout', '90');
            await ev(`(() => { const u = document.getElementById('job-modal-timeout-unit'); u.value = '60'; u.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            assert.equal(await ev(`${errorOf('job-modal-limit')}.hidden`), true, at + 'a good limit clears the sentence');
            await type('#job-modal-timezone', 'Mars/Olympus');
            await waitFor(`!${errorOf('job-modal-timezone')}.hidden`, 'the zone sentence', 8000);
            assert.match(await ev(`${errorOf('job-modal-timezone')}.textContent`), /"Mars\/Olympus" is not a time zone name\. Use one like UTC or Europe\/Berlin\./, at);
            await shot(`job-form-options-${w}`);
            await type('#job-modal-timezone', 'Europe/Berlin');
            await waitFor(`${errorOf('job-modal-timezone')}.hidden`, 'the zone sentence clears', 8000);

            // 6. Save: Name and Workflow are asked for in words, then the job goes with its time limit in seconds
            await ev(`document.getElementById('job-modal-submit').click(); true`);
            assert.equal(await ev(`document.activeElement.id`), 'job-modal-name', at + 'Save with no name puts focus on Name');
            assert.equal(await ev(`document.querySelector('#job-footer .sv-status').textContent`), 'Give the job a name.', at + 'and the line beside the buttons says what is missing');
            await type('#job-modal-name', 'nightly-tests');
            await ev(`document.getElementById('job-modal-submit').click(); true`);
            assert.equal(await ev(`document.activeElement.id`), 'job-modal-workflow', at + 'then on Workflow');
            await ev(`(() => { const s = document.getElementById('job-modal-workflow'); s.value = '7'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(`document.getElementById('job-modal-submit').click(); true`);
            await waitFor(`window.__saved.length === 1`, 'the save', 8000);
            const body = await ev(`window.__saved[0]`);
            assert.equal(body.name, 'nightly-tests'); assert.equal(body.workflow_id, 7); assert.equal(body.job_type, 'workflow');
            assert.equal(body.max_duration_s, 5400, at + '90 minutes is 5400 seconds');
            assert.equal(body.timezone, 'Europe/Berlin'); assert.equal(body.cron_expr, '0 5 * * 1,3');

            // 7. an agent job: Repository, Agent and Prompt first; Base branch, Flags and Cleanup behind More options
            await ev(`window.showJobModal().then(() => { document.querySelector('.job-type-btn[data-type="prompt"]').click(); return true; })`);
            assert.equal(await ev(vis('#job-modal-repo')) && await ev(vis('#job-modal-agent')) && await ev(vis('#job-modal-prompt')), true, at + 'an agent job shows Repository, Agent and Prompt');
            for (const id of ['#job-modal-branch', '#job-modal-flags', '#job-modal-cleanup']) assert.equal(await ev(vis(id)), false, at + id + ' is behind More options');
            await ev(`document.querySelector('#job-modal-more > summary').click(); true`);
            for (const id of ['#job-modal-branch', '#job-modal-flags', '#job-modal-cleanup']) assert.equal(await ev(vis(id)), true, at + id + ' shows in More options');
            await shot(`job-form-agent-${w}`);

            // 8. no workflows yet (#9297): the form opens on the Agent prompt; the Workflow tab says so and offers "Create one", which opens New workflow and comes back
            await ev(`window.__wf = []; window.showJobModal().then(() => true)`);
            await waitFor(`document.querySelector('.job-type-btn[data-type="prompt"]').getAttribute('aria-pressed') === 'true'`, 'the Agent prompt is the type', 8000);
            assert.equal(await ev(vis('#job-modal-prompt')), true, at + 'an agent job shows its Prompt first');
            await ev(`document.querySelector('.job-type-btn[data-type="workflow"]').click(); true`);
            await waitFor(`!!document.getElementById('job-modal-no-workflows') && document.getElementById('job-modal-no-workflows').checkVisibility()`, 'the no-workflow line', 8000);
            assert.match(await ev(`document.getElementById('job-modal-no-workflows').textContent.replace(/\\s+/g, ' ').trim()`), /^No workflows yet\. Create one$/, at);
            await shot(`job-form-no-workflows-${w}`);
            await ev(`document.querySelector('#job-modal-no-workflows button').click(); true`);
            await waitFor(`document.getElementById('wf-create-modal') && getComputedStyle(document.getElementById('wf-create-modal')).display !== 'none'`, 'New workflow opens', 8000);
            assert.equal(await ev(`getComputedStyle(document.getElementById('job-modal')).display`), 'none', at + 'the job form closes');
            await ev(`[...document.querySelectorAll('#wf-footer button')].find(b => b.textContent.trim() === 'Cancel').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, 'the job form comes back', 8000);
            await ev(`[...document.querySelectorAll('#job-footer button')].find(b => b.textContent.trim() === 'Cancel').click(); true`);
            assert.equal(await ev(`getComputedStyle(document.getElementById('job-modal')).display`), 'none', at + 'Cancel closes New job');
        }
        console.log('PASS job form: Name, Workflow and When first; the rest behind More options; errors in words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
