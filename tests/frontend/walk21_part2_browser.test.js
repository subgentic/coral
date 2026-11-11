// #15494 (Walk 21 part 2, 960 x 1040, light theme), one check per finding, each red before its fix:
//   M4  the team page's tabs do not move when a count arrives (an empty count keeps a one-digit pill's room)
//   M7  Edit member: the Thinking select fills its row (it was 82 px wide beside its hint, and cut 'Default'); the hint goes under it
//   L2  the file viewer's title keeps room for its name beside the review chip and the extra chips (it was cut to 'index.h...')
//   L3  the terminal's light surface is a pale one, not a heavy mid-grey slab, and the terminal colours still read on it (3.5:1 or more)
const assert = require('node:assert/strict');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { install: installNT, M, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const B = 'w21-' + Date.now().toString(36);
    let launched = null; // the agent M4 starts: the finally stops it, or its row and its board's subscriber outlive the suite (--fail-on-leak, v2.0.66 #15678)
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 960, height: 1040, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady('startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`document.documentElement.setAttribute('data-theme', 'light'); true`);

        const fails = []; let hex = null;
        const section = async (name, fn) => { try { await fn(); } catch (e) { fails.push(name + ': ' + (e && e.message || e)); } };
        await section('L3', async () => {
        console.log('L3. The light terminal surface is pale and the terminal colours read on it');
        const term = await ev(`(() => {
            const s = getComputedStyle(document.documentElement), v = n => s.getPropertyValue(n).trim();
            const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
            const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
            const bg = v('--xterm-background'), page = v('--bg-primary');
            const names = ['foreground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'bright-black', 'bright-red', 'bright-green', 'bright-yellow', 'bright-blue', 'bright-magenta', 'bright-cyan'];
            const worst = names.map(n => [n, cr(v('--xterm-' + n), bg)]).sort((a, b) => a[1] - b[1])[0];
            return { bg, lum: lum(bg), vsPage: cr(page, bg), worst };
        })()`);
        assert.ok(term.lum >= 0.75, `L3: the light terminal surface ${term.bg} is pale (luminance ${term.lum.toFixed(2)}, at least 0.75)`);
        assert.ok(term.vsPage <= 1.25, `L3: it sits beside the page without a heavy contrast (${term.vsPage.toFixed(2)}:1 against the page, at most 1.25)`);
        assert.ok(term.worst[1] >= 3.5, `L3: every terminal colour reads on it (${term.worst[0]} is ${term.worst[1].toFixed(2)}:1, at least 3.5)`);

        });
        await section('M7', async () => {
        console.log('M7. Edit member: the Thinking select fills its row and its hint is under it');
        const t = T(ev, waitFor); const mem = M(ev, waitFor);
        await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor);
        await t.to(2, { template: /Coding|\(\d+ members\)/ });
        const roles = await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`);
        await ev(`(() => { const b = window.__nt.rows(window.__nt.dlg(${N.team})).find(x => window.__na.name(x) === 'Edit ' + ${JSON.stringify(roles[1])}); b.click(); return true; })()`);
        await waitFor(`!!window.__nt.dlg(${N.member})`, 'the Edit member dialog', 5000);
        await mem.section('Agent'); await settle(500);
        const th = await ev(`(() => { const d = window.__nt.dlg(${N.member}); const s = [...d.querySelectorAll('select')].find(x => x.getClientRects().length && /^Thinking level$/i.test(window.__na.name(x))); const hint = d.querySelector('.provider-think-hint'); const sr = s.getBoundingClientRect(), hr = hint.getBoundingClientRect(); return { w: Math.round(sr.width), hintTop: Math.round(hr.top), selBottom: Math.round(sr.bottom) }; })()`);
        assert.ok(th.w >= 160, `M7: the Thinking select is wide enough for its word and the arrow (${th.w} px, at least 160)`);
        assert.ok(th.hintTop >= th.selBottom - 1, `M7: the hint is under the select, not beside it (hint top ${th.hintTop}, select bottom ${th.selBottom})`);
        await ev(`(() => { const d = window.__nt.dlg(${N.member}); const c = [...d.querySelectorAll('button')].find(b => /^(Cancel|Close)$/i.test(window.__na.name(b))); if (c) c.click(); return true; })()`);
        await ev(`document.querySelectorAll('dialog[open]').forEach(d => d.close()); true`); await settle(300);

        });
        await section('M4', async () => {
        console.log('M4. The team page tabs do not move when a count arrives');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'W21 QA' });
        const sid = launch.body.session_id, sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch)); launched = { sid, sname };
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'W21 QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        const up = await api('POST', `/api/agent/artifacts?session_id=${sid}`, '<h1>hi</h1>', { 'X-Artifact-Name': 'index.html', 'X-Artifact-Media-Type': 'text/html' });
        assert.equal(up.status, 201, JSON.stringify(up)); hex = /[a-f0-9]{64}/.exec(up.body.uri)[0];
        assert.ok((await api('PUT', `/api/board/${B}/artifacts/${hex}/review`, {})).status < 300, 'the file is in review');
        await ev(`window.openTeamPage(${JSON.stringify(B)}, {}); true`);
        await waitFor(`document.querySelectorAll('#team-tabs [role=tab]').length >= 6`, 'the team tabs', 15000);
        const lefts = () => ev(`[...document.querySelectorAll('#team-tabs [role=tab]')].filter(x => x.getClientRects().length).map(x => [x.id, Math.round(x.getBoundingClientRect().left)])`);
        const first = Object.fromEntries(await lefts());
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`); // the Artifacts count is read when the tab is visited
        await waitFor(`/\\d/.test(document.querySelector('#team-tab-artifacts .team-tab-count')?.textContent || '') && /\\d/.test(document.querySelector('#team-tab-agents .team-tab-count')?.textContent || '')`, 'the Artifacts and Agents counts', 20000);
        const later = Object.fromEntries(await lefts());
        const moved = Object.keys(first).filter(k => Math.abs(first[k] - later[k]) > 1).map(k => `${k} ${first[k]} to ${later[k]}`);
        assert.deepEqual(moved, [], 'M4: no tab moved when the counts arrived');

        });
        await section('L2', async () => {
        console.log('L2. The file viewer keeps its title beside the review chip and the extra chips');
        await ev(`import((window.__coralStatic || '/static/') + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(hex)}, { filename: 'index.html', mediaType: 'text/html', board: ${JSON.stringify(B)} })); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-header') && /review/i.test(document.querySelector('#artifact-viewer .artifact-review-state')?.textContent || '')`, 'the viewer with its review chip', 10000);
        await ev(`(() => { const h = document.querySelector('#artifact-viewer .artifact-viewer-header'); h.querySelectorAll('.artifact-viewer-scriptson, .artifact-viewer-chips .av-bar, .artifact-viewer-chips').forEach(e => { e.hidden = false; }); const so = h.querySelector('.artifact-viewer-scriptson'); if (so && !so.textContent.trim()) so.textContent = 'Scripts on'; return true; })()`); // the chips a file with versions and scripts adds beside the review chip
        await settle(300);
        const ti = await ev(`(() => { const n = document.querySelector('#artifact-viewer .artifact-viewer-title-name'); const t = document.querySelector('#artifact-viewer .artifact-viewer-title'); const r = document.createRange(); r.selectNodeContents(n); const text = r.getBoundingClientRect().width; return { box: Math.round(t.getBoundingClientRect().width), text: Math.round(text), cut: t.scrollWidth > t.clientWidth + 1, name: n.textContent.trim() }; })()`);
        assert.equal(ti.name, 'index.html');
        assert.ok(!ti.cut, `L2: the title shows 'index.html' whole (title box ${ti.box} px, text ${ti.text} px)`);
        });
        assert.deepEqual(fails, [], 'Walk 21 part 2 findings');
        console.log('PASS Walk 21 part 2: M4 tabs stay put, M7 Thinking select, L2 viewer title, L3 light terminal surface');
    } finally {
        if (launched) { try { await ev(`fetch('/api/sessions/live/' + encodeURIComponent(${JSON.stringify(launched.sname)}) + '/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(launched.sid)} }) }).then(() => true)`); } catch { /* best effort */ } }
        await removeBoards(ev, [B]).catch(() => {}); await client.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
