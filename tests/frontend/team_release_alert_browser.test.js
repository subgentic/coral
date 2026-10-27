// The Release alert of the team's Health check (#9020, Goal #80, the server's #8948): a switch, off by default; on, it has a Branch, a Tag pattern (v* also matches prereleases), a Wait in minutes (60 to 43200) and an Also tell
// picker (blank: only the orchestrator). A branch or a tag pattern the server would not read and a wait outside its range are refused in words at the field before any request; a member who is not on the team is refused by the server
// and shown at its field and in the bar by the field's label; a valid setting is saved through the real PUT and read back. Real board on the isolated dev server (removed again). 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const RUN = 'rel-' + Date.now().toString(36), made = [];
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
            console.log(`${at}the Release alert fields`);
            await ev(`document.getElementById('team-settings-workspace')?.remove(); import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) })); true`);
            await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]') && !!document.querySelector('#team-settings-workspace .settings-tab[data-section=messaging]')`, 'the settings page', 15000);
            await waitFor(`(() => { const t = document.querySelector('#team-settings-workspace .settings-tab[data-section=health]'); if (!t) return false; t.click(); const p = document.querySelector('${P}'); return !!p && !p.closest('.settings-pane').hidden && !!document.querySelector('${P} [name=release_on]'); })()`, 'the Health check group with the Release alert', 15000);
            const form = await ev(`(() => { const g = n => document.querySelector('${P} [name=' + n + ']'); return { on: g('release_on').checked, branch: g('release_branch').value, tag: g('release_tag_pattern').value, wait: g('release_wait_min').value, range: [g('release_wait_min').min, g('release_wait_min').max], dis: ['release_branch', 'release_tag_pattern', 'release_wait_min', 'release_nudge'].map(n => g(n).disabled), opts: [...g('release_nudge').options].map(o => o.value), hints: ['release_tag_pattern', 'release_wait_min'].map(k => (document.querySelector('${P} .sv-row[data-key=' + k + '] .sv-help') || {}).textContent.trim()), unlabelled: ['release_on', 'release_branch', 'release_tag_pattern', 'release_wait_min', 'release_nudge'].filter(n => { const e = g(n); return !((e.labels && e.labels.length) || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby')); }) }; })()`);
            assert.equal(form.on, false, at + 'off by default'); assert.deepEqual([form.branch, form.tag, form.wait], ['main', 'v*', '1440']); assert.deepEqual(form.range, ['60', '43200']);
            assert.deepEqual(form.dis, [true, true, true, true], at + 'the fields are live only while the switch is on'); assert.deepEqual(form.opts, ['', 'Boss', 'Dev One']);
            assert.deepEqual(form.hints, ['v* also matches prereleases, such as v2.0.1-beta.', '1 hour to 30 days'], at + 'the hints say what the pattern matches and the wait\'s range in words'); assert.deepEqual(form.unlabelled, []);
            // the fields that repeat Branch, Wait and Also tell under each rule are named with their rule, so tabbing from field to field is not "Branch" twice (#9117)
            const fieldNames = await ev(`['landing_branch', 'landing_wait_min', 'landing_nudge', 'release_branch', 'release_tag_pattern', 'release_wait_min', 'release_nudge', 'goals_ready_wait_min', 'unowned_tasks_wait_min'].map(n => (document.querySelector('${P} [name=' + n + ']') || {getAttribute: () => null}).getAttribute('aria-label'))`);
            assert.deepEqual(fieldNames, ['Landing: Branch', 'Landing: Wait', 'Landing: Also tell', 'Release: Branch', 'Release: Tag pattern', 'Release: Wait', 'Release: Also tell', 'Goals ready to close: Wait', 'Open tasks with no goal or assignee: Wait'], at + 'each field is named with its rule: ' + JSON.stringify(fieldNames));

            console.log(`${at}a value the server would not read is refused at its field, before any request`);
            await ev(`window.__puts = 0; if (!window.__wrapped) { window.__wrapped = true; const w = window.fetch; window.fetch = (u, o = {}) => { if ((o.method || 'GET') === 'PUT' && /board\\/[^/]+\\/settings$/.test(String(u))) window.__puts++; return w(u, o); }; } true`);
            await fire('release_on', true);
            await fire('release_branch', '../x'); await fire('release_tag_pattern', '-v1'); await fire('release_wait_min', '30'); await save();
            await waitFor(`(document.querySelector('${P} .sv-row[data-key=release_branch] .sv-error') || {}).textContent`, 'the branch refusal', 5000);
            assert.match(await rowError('release_branch'), /is not a branch name Coral reads/); assert.match(await rowError('release_tag_pattern'), /is not a tag pattern Coral reads/); assert.match(await rowError('release_wait_min'), /60 to 43200/);
            assert.equal(await ev(`window.__puts`), 0, at + 'nothing was sent');

            console.log(`${at}a valid setting is saved and read back`);
            await fire('release_branch', 'main'); await fire('release_tag_pattern', 'v2.*'); await fire('release_wait_min', '120'); await fire('release_nudge', 'Dev One'); await save();
            await waitFor(`window.__puts >= 1`, 'the save', 8000);
            let stored;
            for (let i = 0; i < 30 && !(stored && stored.on && stored.nudge); i++) { stored = ((await api('/settings')).body || {}).health?.release; if (!(stored && stored.on && stored.nudge)) await new Promise(r => setTimeout(r, 200)); } // sleep-ok: the PUT lands a frame after the click
            assert.deepEqual(stored, { on: true, branch: 'main', tag_pattern: 'v2.*', wait_min: 120, nudge: 'Dev One' }, at + 'what the server kept');
            await shot(`release-alert-${w}`);

            console.log(`${at}a refusal from the server is shown at its field and by its label in the bar`);
            await ev(`{ const s = ${h('release_nudge')}; s.append(Object.assign(document.createElement('option'), { value: 'Ghost', textContent: 'Ghost' })); } true`);
            await fire('release_nudge', 'Ghost'); await save();
            await waitFor(`/not a member/.test((document.querySelector('${P} .sv-row[data-key=release_nudge] .sv-error') || {}).textContent || '')`, 'the refusal at the field', 8000);
            const bar = await ev(`document.querySelector('#team-settings-workspace .sv-status').textContent`);
            assert.match(bar, /Also tell: "Ghost" is not a member of this team/, at + 'the bar names the field by its label'); assert.doesNotMatch(bar, /release\.|health\.|_/, at + 'no API path: ' + bar);
            await shot(`release-alert-refused-${w}`);
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, at + 'no sideways scroll');
            console.log('   ✓');
        }
        console.log('PASS release alert: off by default, Branch, Tag pattern, Wait and Also tell, refused at the field in words, saved through the real PUT');
    } finally { await removeBoards(ev, made).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
