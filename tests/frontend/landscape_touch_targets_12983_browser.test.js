// A landscape phone is a coarse pointer wider than 767 px, so the phone touch sizes keyed to max-width never reached it (#12983, the keyboard audit's landscape pass): the team page's header buttons were 36 px and its
// toolbar 32 px, the Settings dialog's pane buttons 36 px, the agent list's kebab 24 px, the Messages and Analytics "All" filters 36-39 px wide. touch.css gives them the touch size from the pointer. Measured by what a
// finger reaches (the points 20 px above and below, and left and right of a control's centre hit it, or its box is 44 px), at 844x390 and 915x412 with touch; with a mouse at 1280 the sizes are what they were.
// The real isolated dev server, a board and a real agent (the mock in ready mode). Not on Windows (a script CLI).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
if (process.platform === 'win32') { console.log('landscape_touch_targets_12983_browser: SKIPPED (a script CLI)'); process.exit(0); }

(async () => {
    const client = await CDP({ port: parseInt(process.env.CDP_PORT || '9222', 10) });
    const { Page, Runtime, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const api = (m, p, b) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${b === undefined ? 'undefined' : JSON.stringify(JSON.stringify(b))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
    const team = 'lt-' + Date.now().toString(36); let originalCli = null, wrapperDir = '', dir = '', agent = null; const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    // the controls named by selector: does a finger reach each (a point 20 px away on each axis still hits it, or its box is 44 px on that axis)
    const reach = sels => ev(`(() => ${JSON.stringify(sels)}.flatMap(sel => [...document.querySelectorAll(sel)].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden').map(b => { const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2; const hit = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === b || b.contains(t)); };
        return { sel, name: (b.getAttribute('aria-label') || b.textContent || b.id).trim().slice(0, 28), box: Math.round(r.width) + 'x' + Math.round(r.height), h: Math.round(r.height), tall: r.height >= 44 || (hit(cx, cy - 20) && hit(cx, cy + 20)), wide: r.width >= 44 || (hit(cx - 20, cy) && hit(cx + 20, cy)) }; })))()`);
    try {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        await api('POST', `/api/board/${team}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator', session_name: 'orch-s' });
        const g = await api('POST', `/api/board/${team}/goals`, { subscriber_id: 'Operator', title: 'Importer is live' });
        await api('POST', `/api/board/${team}/tasks`, { title: 'Read the file', subscriber_id: 'Orchestrator', assignee: 'Orchestrator', goal_id: g.data && g.data.id });
        await api('POST', `/api/board/${team}/messages`, { subscriber_id: 'Orchestrator', content: 'hello' });
        const settings = await api('GET', '/api/settings'); originalCli = settings.data && (settings.data.settings || settings.data).cli_path_claude;
        wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-lt-')); const wrapper = path.join(wrapperDir, 'claude'); fs.writeFileSync(wrapper, `#!/bin/sh\nMOCK_AGENT_READY=1 exec "${originalCli}" "$@"\n`, { mode: 0o755 });
        await api('PUT', '/api/settings', { cli_path_claude: wrapper });
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coral-ltagent-')));
        await api('POST', '/api/sessions/launch', { working_dir: dir, agent_type: 'claude' });
        await waitFor(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).some(s => s.working_directory === ${JSON.stringify(dir)})`, 'the agent', { timeout: 20000 });
        agent = await ev(`(window._coralGetLiveSessions() || []).find(s => s.working_directory === ${JSON.stringify(dir)})`);
        const TEAMBAR = ['.team-page-add', '.team-page-settings', '.team-page-stop', '.team-page-more'];
        const TOOLBAR = ['.team-panel .list-bar-search', '.team-panel .team-tb-select', '.team-panel .team-tb-action'];
        for (const [w, h] of [[844, 390], [915, 412]]) {
            const tag = `${w}x${h}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            const visit = async (url, sel) => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await coralReady(); await waitFor(sel, url, { timeout: 15000 }).catch(() => {}); await new Promise(r => setTimeout(r, 700)); }; // sleep-ok: the page draws its controls in a few steps
            await visit(`/team/${team}/goals`, `!!document.querySelector('.team-page-more, #team-page-more')`);
            let r = await reach([...TEAMBAR, ...TOOLBAR]);
            check(`${tag}: the team page has its header buttons and toolbar`, r.length >= 6, JSON.stringify(r.map(x => x.name)));
            check(`${tag}: the team page's header buttons and toolbar are reached by a finger`, r.every(x => x.tall && x.wide), JSON.stringify(r.filter(x => !x.tall || !x.wide)));
            await visit(`/team/${team}/messages`, `!!document.querySelector('.mb-pill, #bm-search')`);
            r = await reach(['.goals-chip.mb-pill']); check(`${tag}: Messages' All filter is reached`, r.length >= 1 && r.every(x => x.tall && x.wide), JSON.stringify(r));
            await visit('/analytics', `!!document.querySelector('.eff-seg-btn, .view-list')`);
            r = await reach(['.eff-seg-btn']); check(`${tag}: Analytics' All filter is reached`, r.every(x => x.tall && x.wide), JSON.stringify(r));
            await visit('/agents', `!!document.querySelector('.sidebar-kebab-btn')`);
            r = await reach(['.sidebar-kebab-btn']); check(`${tag}: the agent list's kebab is reached`, r.length >= 1 && r.every(x => x.tall && x.wide), JSON.stringify(r));
            await visit('/inbox/needs', `true`); await ev(`window.showSettingsModal(); true`); await waitFor(`!!document.querySelector('#settings-modal .settings-tab')`, 'Settings panes', { timeout: 10000 }).catch(() => {}); await new Promise(r2 => setTimeout(r2, 700)); // sleep-ok: the dialog opens in steps
            r = await reach(['#settings-modal .settings-tab']); check(`${tag}: Settings' pane buttons are reached`, r.length >= 8 && r.every(x => x.tall && x.wide), JSON.stringify(r.filter(x => !x.tall || !x.wide).slice(0, 4)));
        }
        // a mouse keeps the desktop sizes
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + `/team/${team}/goals` }); await Page.loadEventFired(); await coralReady(); await waitFor(`!!document.querySelector('.team-page-more, #team-page-more')`, 'team page', { timeout: 15000 }).catch(() => {}); await new Promise(r2 => setTimeout(r2, 700)); // sleep-ok: the page draws its controls in a few steps
        const mouse = await reach([...TEAMBAR, ...TOOLBAR]);
        check('with a mouse the team page keeps its desktop control heights (under 40 px)', mouse.length >= 6 && mouse.every(x => x.h < 40), JSON.stringify(mouse.map(x => [x.name, x.h])));
    } finally {
        if (agent) await api('POST', `/api/sessions/live/${encodeURIComponent(agent.session_name || agent.name)}/kill`, { session_id: agent.session_id, agent_type: 'claude' }).catch(() => {});
        if (originalCli) await api('PUT', '/api/settings', { cli_path_claude: originalCli }).catch(() => {});
        await ev(`fetch('/api/board/${team}', { method: 'DELETE' })`).catch(() => {});
        for (const d of [dir, wrapperDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* stays */ } }
        await client.close();
    }
    assert.deepEqual(problems, [], 'landscape touch targets:\n  ' + problems.join('\n  '));
    console.log('PASS landscape phone touch targets: the team page, Settings panes, kebab and filters are reached by a finger; a mouse is unchanged');
})().catch(e => { console.error(e); process.exit(1); });
