// #21027 (brief task 3, goal #302): the review size guard's Team settings group and its over-limit banner on a task in review, as the approved stage-1 mock shows them. The routes (GET/PUT
// /api/board/{team}/review-size and GET /api/board/{team}/tasks/{id}/review-size) are stubbed at the page's fetch. 1280 and 390 px. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const sceneShots = require('./helpers/scene_shots');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const TEAM = 'size-guard-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = sceneShots(Page);
    const S = `(window.__coralStatic || '/static/')`;
    const row = k => `document.querySelector('#team-settings-workspace .sv-row[data-key=${k}]')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            const at = `${width}: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 }); await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(() => fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Lead Developer' }) })).then(() => true)`);
            await ev(`window.__setting = { on: false, lines: 0, files: 0, skip: [], only_roles: [], roles: { 'Frontend Dev': { lines: 300, files: 0 } } }; window.__puts = []; window.__verdict = { applies: true, over: true, lines: 1842, files: 31, skipped_lines: 212, skipped_files: 4, limit_lines: 800, limit_files: 20 }; window.__verdictStatus = 200; window.__verdictCalls = 0; window.__refuse = '';
                (() => { const real = window.fetch, json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = (o.method || 'GET').toUpperCase();
                    if (url.pathname === '/api/board/${TEAM}/review-size') { if (m === 'GET') return json(window.__setting); window.__puts.push(JSON.parse(o.body)); if (window.__refuse) return json({ error: window.__refuse }, 400); window.__setting = JSON.parse(o.body); return json(window.__setting); }
                    if (/\\/api\\/board\\/${TEAM}\\/tasks\\/7\\/review-size$/.test(url.pathname)) { window.__verdictCalls++; return json(window.__verdictStatus === 200 ? window.__verdict : {}, window.__verdictStatus); }
                    return real(u, o); }; return true; })()`);

            // 1. The setting: off by default, the mock's fields, saved whole
            await ev(`import(${S} + 'team_settings_page.js').then(m => m.showTeamSettingsPage(${JSON.stringify(TEAM)}, { page: (document.getElementById('pin-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pin-host' }))) })); true`);
            await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, `${at}the Team settings`, 15000);
            await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=review-size]').click(); true`);
            await waitFor(`!!${row('rs_on')} && ${row('rs_on')}.getClientRects().length > 0`, `${at}the Review size guard group`);
            const off = await ev(`({ on: ${row('rs_on')}.querySelector('input').checked, lines: ${row('rs_lines')}.querySelector('input').disabled, label: ${row('rs_on')}.textContent, help: ${row('rs_on')}.textContent, title: document.querySelector('#team-settings-workspace .settings-pane[data-section=review-size] .settings-pane-title')?.textContent })`);
            assert.equal(off.on, false, `${at}off by default`); assert.equal(off.lines, true, `${at}the numbers wait for the switch`);
            assert.match(off.label, /Warn when a change is too big to review/); assert.match(off.help, /Off by default\. Warns only: nothing is blocked or sent back\./);
            assert.match(off.title || '', /Review size guard/);
            await shot('size-setting-off-' + width);
            await ev(`${row('rs_on')}.querySelector('input').click(); true`);
            await waitFor(`!${row('rs_lines')}.querySelector('input').disabled`, `${at}the numbers open with the switch`);
            // on with no limit is refused before any request
            await ev(`[...document.querySelectorAll('#team-settings-workspace button')].find(b => b.textContent === 'Save settings').click(); true`);
            await waitFor(`/Set a limit for lines or files/.test(document.getElementById('team-settings-workspace').textContent)`, `${at}on with no limit says so`);
            assert.equal(await ev('window.__puts.length'), 0, `${at}nothing sent for an on switch with no limit`);
            const fill = (k, v) => ev(`(() => { const i = ${row(k)}.querySelector('input'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await fill('rs_lines', '800'); await fill('rs_files', '20'); await fill('rs_skip', '*.lock, **/generated/**, tests/golden/**');
            const stale = () => ev(`/Set a limit for lines or files/.test(document.getElementById('team-settings-workspace').textContent) || !!document.querySelector('#team-settings-workspace [aria-invalid=true]')`);
            await waitFor(`!(/Set a limit for lines or files/.test(document.getElementById('team-settings-workspace').textContent))`, `${at}the no-limit line goes once a limit is entered`);
            assert.equal(await stale(), false, `${at}no error is left on valid limits`);
            // Files alone is a limit too: empty Lines, Files only, no error; then Lines emptied again with the switch on says so
            await fill('rs_lines', '');
            assert.equal(await stale(), false, `${at}Files alone is enough`);
            await fill('rs_files', '');
            await ev(`[...document.querySelectorAll('#team-settings-workspace button')].find(b => b.textContent === 'Save settings').click(); true`);
            await waitFor(`/Set a limit for lines or files/.test(document.getElementById('team-settings-workspace').textContent)`, `${at}no limit says so again`);
            await fill('rs_files', '20');
            await waitFor(`!(/Set a limit for lines or files/.test(document.getElementById('team-settings-workspace').textContent))`, `${at}Files alone clears the no-limit line`);
            await fill('rs_lines', '800');
            await ev(`(() => { const s = ${row('rs_scope')}.querySelector('select'); s.value = 'roles'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`${row('rs_roles')}.getClientRects().length > 0 && !!${row('rs_roles')}.querySelector('input[value="Lead Developer"]')`, `${at}the roles appear for Only these roles`);
            await ev(`${row('rs_roles')}.querySelector('input[value="Lead Developer"]').click(); true`);
            await shot('size-setting-on-' + width);
            // a refusal keeps the page's words and saves nothing
            await ev(`window.__refuse = 'Only the Orchestrator or the Operator can change this.'; [...document.querySelectorAll('#team-settings-workspace button')].find(b => b.textContent === 'Save settings').click(); true`);
            await waitFor(`/Only the Orchestrator or the Operator can change this\\./.test(document.getElementById('team-settings-workspace').textContent)`, `${at}the server's reason is shown`);
            assert.equal(await ev('JSON.stringify(window.__setting.on)'), 'false', `${at}a refused save changes nothing`);
            await ev(`window.__refuse = ''; window.__puts.length = 0; [...document.querySelectorAll('#team-settings-workspace button')].find(b => b.textContent === 'Save settings').click(); true`);
            await waitFor(`window.__puts.length === 1`, `${at}the setting is saved`);
            const put = await ev('window.__puts[0]');
            assert.equal(put.over_limit, 'warn', `${at}Warn is the default and goes back with the whole setting`);
            const overOpts = await ev(`[...${row('rs_over')}.querySelectorAll('option')].map(o => o.value + '|' + o.textContent)`);
            assert.deepEqual(overOpts, ['warn|Warn: show a banner', 'send_back|Send back: ask the author to split', 'split|Split: the Orchestrator files follow-ups'], `${at}the mock's three choices`);
            await ev(`(() => { const s = ${row('rs_over')}.querySelector('select'); s.value = 'send_back'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(`window.__puts.length = 0; [...document.querySelectorAll('#team-settings-workspace button')].find(b => b.textContent === 'Save settings').click(); true`);
            await waitFor(`window.__puts.length === 1`, `${at}the choice is saved`);
            assert.equal((await ev('window.__puts[0]')).over_limit, 'send_back', `${at}Send back is saved`);
            assert.deepEqual({ on: put.on, lines: put.lines, files: put.files, skip: put.skip, only_roles: put.only_roles }, { on: true, lines: 800, files: 20, skip: ['*.lock', '**/generated/**', 'tests/golden/**'], only_roles: ['Lead Developer'] }, `${at}saved whole: ` + JSON.stringify(put));
            assert.deepEqual(put.roles, { 'Frontend Dev': { lines: 300, files: 0 } }, `${at}a role's own numbers go back as they were read`);

            // 2. The banner: only on a change over the limit
            const page = () => ev(`(async () => { const ttp = await import(${S} + 'team_tasks_page.js'); let host = document.getElementById('size-host'); if (host) host.remove(); host = Object.assign(document.createElement('main'), { id: 'size-host' }); host.style.cssText = 'position:fixed;inset:0;z-index:1000;background:var(--bg-primary);overflow:auto;padding:16px'; document.body.append(host);
                ttp.renderTaskPage(host, { id: 7, title: 'Pictures in more text boxes', status: 'review_pending', assigned_to: 'Dev', version: 0 }, { backLabel: 'Tasks', onBack() {}, openGoal() {}, project: ${JSON.stringify(TEAM)} }, 'view'); return true; })()`);
            await page();
            await waitFor(`!!document.querySelector('#size-host .review-size-banner')`, `${at}the banner on an oversized change`);
            const b = await ev(`(() => { const e = document.querySelector('#size-host .review-size-banner'); return { text: e.textContent.replace(/^warning/, ''), role: e.getAttribute('role'), h: e.getBoundingClientRect().height, over: e.scrollWidth > e.clientWidth + 1 }; })()`);
            assert.match(b.text, /Large change\. 1,842 lines in 31 files; your team's limit is 800 lines or 20 files\. 212 lines in 4 skipped paths are not counted\./, `${at}the mock's words from the verdict: ` + b.text);
            assert.match(b.text, /This is a warning only\. You can still review and approve it\./);
            assert.equal(b.role, 'status'); assert.ok(!b.over, `${at}the banner does not overflow`);
            await shot('size-banner-' + width);
            for (const [name, patch, status] of [['under the limit', { over: false }, 200], ['guard off', { applies: false, over: undefined }, 200], ['no diff', {}, 404]]) {
                await ev(`window.__verdict = { applies: true, over: true, lines: 1842, files: 31, skipped_lines: 212, skipped_files: 4, limit_lines: 800, limit_files: 20, ...${JSON.stringify(patch)} }; window.__verdictStatus = ${status}; window.__verdictCalls = 0; true`);
                await page(); await waitFor(`window.__verdictCalls >= 1`, `${at}${name}: the verdict is asked for`);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: waiting for a banner that must NOT appear
                assert.equal(await ev(`!!document.querySelector('#size-host .review-size-banner')`), false, `${at}no banner: ${name}`);
            }
            // a task that is not in review never asks
            await ev(`window.__verdictCalls = 0; (async () => { const ttp = await import(${S} + 'team_tasks_page.js'); const host = document.getElementById('size-host'); ttp.renderTaskPage(host, { id: 7, title: 'Working', status: 'in_progress', assigned_to: 'Dev', version: 0 }, { backLabel: 'Tasks', onBack() {}, openGoal() {}, project: ${JSON.stringify(TEAM)} }, 'view'); return true; })()`);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: waiting for a request that must NOT happen
            assert.equal(await ev('window.__verdictCalls'), 0, `${at}a task not in review never asks`);

            // 3. Send back and Split (#21059): one button on the banner, a note or a confirmation, then the one POST
            await ev(`window.__acts = []; (() => { const prev = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (o.method === 'POST' && /\\/review-size\\/(send-back|split)$/.test(url.pathname)) { window.__acts.push({ path: url.pathname.split('/').pop(), body: o.body ? JSON.parse(o.body) : null }); return window.__actAnswer ? Promise.resolve(new Response(JSON.stringify(window.__actAnswer.body), { status: window.__actAnswer.status, headers: { 'Content-Type': 'application/json' } })) : Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return prev(u, o); }; })(); true`);
            const base = { applies: true, over: true, lines: 1842, files: 31, skipped_lines: 212, skipped_files: 4, limit_lines: 800, limit_files: 20 };
            const NOTE = "This change is over the team's limit: 1,842 lines in 31 files (the limit is 800 lines or 20 files). Please split it into smaller changes and submit them for review one at a time.";
            await ev(`window.__verdictStatus = 200; window.__verdict = ${JSON.stringify({ ...base, over_limit: 'send_back', send_back_note: NOTE })}; true`);
            await page();
            await waitFor(`!!document.querySelector('#size-host .review-size-action')`, `${at}Send back puts one button on the banner`);
            const sb = await ev(`(() => { const e = document.querySelector('#size-host .review-size-banner'); return { text: e.textContent, btns: e.querySelectorAll('button').length, btn: e.querySelector('button').textContent }; })()`);
            assert.equal(sb.btns, 1); assert.equal(sb.btn, 'Send back to author');
            assert.match(sb.text, /Your team sends a change this size back to its author\./); assert.match(sb.text, /You can still approve it\./);
            assert.equal(await ev('window.__acts.length'), 0, `${at}nothing is sent until the button is pressed`);
            await ev(`document.querySelector('#size-host .review-size-action').click(); true`);
            await waitFor(`!!document.querySelector('dialog.review-size-dialog[open]')`, `${at}the note opens`);
            assert.equal(await ev(`document.querySelector('dialog.review-size-dialog h3').textContent`), 'Send back to Dev?');
            assert.equal(await ev(`document.querySelector('dialog.review-size-dialog textarea').value`), NOTE, `${at}the note is filled in with the size and the limit`);
            await shot('size-send-back-' + width);
            await ev(`(() => { const t = document.querySelector('dialog.review-size-dialog textarea'); t.value = t.value + ' Thanks.'; return true; })()`);
            await ev(`window.__actAnswer = { status: 403, body: { error: 'only the team\\'s orchestrator or the Operator can send a task back for its size' } }; document.querySelector('dialog.review-size-dialog button[type=submit]').click(); true`);
            await waitFor(`/Not sent back: only the team/.test(document.querySelector('dialog.review-size-dialog .review-size-error').textContent)`, `${at}a refusal is said in the dialog, which stays open`);
            await ev(`window.__acts.length = 0; window.__actAnswer = null; document.querySelector('dialog.review-size-dialog button[type=submit]').click(); true`);
            await waitFor(`window.__acts.length === 1 && !document.querySelector('dialog.review-size-dialog')`, `${at}Send back posts the note and closes`);
            assert.deepEqual(await ev('window.__acts[0]'), { path: 'send-back', body: { note: NOTE + ' Thanks.' } }, `${at}the edited note is what is sent`);
            // Cancel sends nothing
            await ev(`window.__acts.length = 0; document.querySelector('#size-host .review-size-action').click(); true`);
            await waitFor(`!!document.querySelector('dialog.review-size-dialog[open]')`, `${at}the note opens again`);
            await ev(`[...document.querySelectorAll('dialog.review-size-dialog button')].find(b => b.textContent === 'Cancel').click(); true`);
            await waitFor(`!document.querySelector('dialog.review-size-dialog')`, `${at}Cancel closes it`);
            assert.equal(await ev('window.__acts.length'), 0, `${at}Cancel sends nothing`);

            const ASK = 'Split #7 (1,842 lines in 31 files, limit 800 lines or 20 files) into follow-up tasks under the limit.';
            await ev(`window.__verdict = ${JSON.stringify({ ...base, over_limit: 'split', split_ask: ASK })}; true`);
            await page();
            await waitFor(`!!document.querySelector('#size-host .review-size-action')`, `${at}Split puts one button on the banner`);
            assert.equal(await ev(`document.querySelector('#size-host .review-size-action').textContent`), 'Split into follow-ups');
            assert.match(await ev(`document.querySelector('#size-host .review-size-banner').textContent`), /Your team splits a change this size into follow-up tasks\./);
            await ev(`document.querySelector('#size-host .review-size-action').click(); true`);
            await waitFor(`document.getElementById('confirm-modal-title') && /^Split #7 into follow-ups\\?$/.test(document.getElementById('confirm-modal-title').textContent)`, `${at}the confirmation names the task`);
            assert.ok((await ev(`document.getElementById('confirm-modal-message').textContent`)).includes(ASK), `${at}the confirmation quotes what the Orchestrator is asked`);
            assert.equal(await ev('window.__acts.length'), 0, `${at}nothing is sent before the confirmation`);
            await shot('size-split-' + width);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__acts.length === 1`, `${at}Split asks the Orchestrator`);
            assert.equal((await ev('window.__acts[0]')).path, 'split');
            // Warn mode keeps the banner as it was: no button
            await ev(`window.__verdict = ${JSON.stringify({ ...base, over_limit: 'warn' })}; true`);
            await page();
            await waitFor(`!!document.querySelector('#size-host .review-size-banner')`, `${at}the Warn banner`);
            assert.equal(await ev(`document.querySelectorAll('#size-host .review-size-banner button').length`), 0, `${at}Warn has no button`);
        }
        console.log('PASS review size guard: setting off by default, saved whole, refused with the server\'s words; banner only on an oversized change, in the mock\'s words');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
