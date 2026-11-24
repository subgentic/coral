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
        }
        console.log('PASS review size guard: setting off by default, saved whole, refused with the server\'s words; banner only on an oversized change, in the mock\'s words');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
