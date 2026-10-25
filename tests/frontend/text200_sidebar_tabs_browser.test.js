// The sidebar tabs at a large text size and on a phone (#7562, after the team page and Analytics had problems nobody saw at 100%): Chats, Jobs, Workflows and Docs, each filled with data, at 1280 px with 200% text, at 390 px,
// and at 390 px with 200% text, in the dark and the light theme. In each: the page does not scroll sideways, no control is cut off or hidden by an edge, no text is clipped without an ellipsis, no word is broken across lines
// (a word wider than its own box), and on a touch screen every control is 44 px. 200% text is the root font doubled, as the text200 suites do it. The lists are the real renderers given stubbed data. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { SCAN } = require('./helpers/phone_scan');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;
const SHOTS = process.env.CORAL_SCREENSHOT_DIR || '';

const VIEWS = [['1280 px, 200% text', 1280, 800, false, 32], ['390 px', 390, 844, true, 16], ['390 px, 200% text', 390, 844, true, 32]];
const JOBS = [
    { id: 1, name: 'Nightly build and release notes for the whole monorepo', cron_expr: '0 3 * * 1-5', enabled: true, agent_type: 'claude', prompt: 'p', repo_path: '/tmp/a-long-folder-name/with/many/parts', max_duration_s: 3600, consecutive_failures: 0 },
    { id: 2, name: 'Weekly dependency check', cron_expr: '0 9 * * 1', enabled: false, agent_type: 'codex', prompt: 'p', repo_path: '/tmp', max_duration_s: 1800, consecutive_failures: 3 },
];
const WORKFLOWS = [{ id: 1, name: 'nightly-build-and-publish', description: 'Build, test and publish the release candidate to every channel we ship to', enabled: true, step_count: 4, last_run: null }, { id: 2, name: 'release-notes', description: '', enabled: false, step_count: 1, last_run: null }];
const STUB = `(() => { const inner = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    window.fetch = (url, opts = {}) => { const path = String(url && url.url || url).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0], m = (opts.method || 'GET').toUpperCase();
        if (m === 'GET' && path === '/api/scheduled/jobs') return json({ jobs: ${JSON.stringify(JOBS)} });
        if (m === 'GET' && path === '/api/workflows') return json({ workflows: ${JSON.stringify(WORKFLOWS)} });
        if (m === 'GET' && path === '/api/scheduled/jobs/1') return json(${JSON.stringify(JOBS[0])});
        if (m === 'GET' && /^\\/api\\/scheduled\\/jobs\\/1\\/runs/.test(path)) return json({ runs: [] });
        if (m === 'GET' && path === '/api/workflows/1') return json(${JSON.stringify({ ...WORKFLOWS[0], steps: [{ id: 1, name: 'build', agent_type: 'claude', prompt: 'Build it' }] })});
        return inner(url, opts); }; })();`;
const HISTORY = `(async () => { const m = await import(${S} + 'history_list.js'); const at = (dd, hh, mm) => { const d = new Date(); d.setDate(d.getDate() - dd); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
    const rows = [{ session_id: 'aaaaaa1', summary_title: 'Fix the flaky test', source_type: 'claude', display_name: 'Ada', last_timestamp: at(0, 14, 32), duration_sec: 21 * 60 },
        { session_id: 'eeeeee1', summary_title: 'An extremely long chat title that goes on and on and on, well past what one row of the sidebar can hold at any size at all', source_type: 'codex', display_name: 'A-long-agent-name', last_timestamp: at(1, 17, 20) },
        { session_id: 'bbbbbb1', source_type: 'claude', display_name: 'Ada', last_timestamp: at(2, 8, 0) },
        { type: 'group', session_id: 'board:team-a', title: 'a-team-with-a-long-name', updated_at: at(0, 13, 5), message_count: 23, subscriber_count: 4 }];
    m.renderHistorySessions(rows, rows.length, 1, 50); return true; })()`;
// words wider than the box they are in (canvas-measured with the element's own font), for elements that own text; and clipped/hidden controls come from the shared scan
const BROKEN = `(() => { const c = document.createElement('canvas').getContext('2d'); const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden], .sr-only, [data-scan-skip]');
    return [...document.querySelectorAll('body *')].filter(e => vis(e) && ![...e.childNodes].every(n => n.nodeType !== 3 || !n.textContent.trim()) && !/^(SCRIPT|STYLE|CODE|PRE|TEXTAREA|INPUT|OPTION|SELECT|SVG)$/i.test(e.tagName) && !e.closest('.sched-path, code, pre')).filter(e => { const cs = getComputedStyle(e); c.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' '); const room = e.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); if (!(room > 8)) return false; // a path or an address has no space to break at: it is shown whole, in code, or may break anywhere
        return own.split(/[\\s-]+/).some(w => w && c.measureText(w).width > room + 1); }).map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase()) + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '') + ' "' + e.textContent.trim().slice(0, 28) + '"').slice(0, 8); })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const theme of ['dark', 'light']) for (const [label, w, h, mobile, font] of VIEWS) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await setTheme(ev, theme);
            await ev(`document.documentElement.style.fontSize = '${font}px'; true`);
            for (const [name, tab, prep, open] of [['Chats', 'history', HISTORY, null], ['Jobs', 'jobs', null, null], ['Jobs, one job open', 'jobs', null, `document.querySelector('#scheduled-jobs-list .sched-row .row-btn').click()`], ['Workflows', 'workflows', null, null], ['Workflows, one workflow open', 'workflows', null, `document.querySelector('.wf-nav-row .row-btn').click()`], ['Docs', 'docs', null, null], ['Docs, one topic open', 'docs', null, `document.querySelector('#docs-nav-list .row-btn').click()`]]) {
                const where = `${name}, ${label}, ${theme}`;
                try {
                    await ev(`window.switchNavTab('${tab}'); true`); await settle(900);
                    if (prep) { await ev(prep); await settle(500); }
                    if (open) { await ev(`${open}; true`); await settle(900); }
                    const r = await ev(SCAN); const broken = await ev(BROKEN);
                    if (r.missing) { problems.push(`${where}: scene not found`); continue; }
                    if (r.docOver > 0 || r.nWide) problems.push(`${where}: wider than the screen (docOver ${r.docOver}) ${r.wide.slice(0, 3).join('; ')}`);
                    if (r.clipped.length) problems.push(`${where}: clipped ${r.clipped.slice(0, 3).join('; ')}`);
                    if (mobile && r.nSmall) problems.push(`${where}: smaller than 44 px ${r.small.slice(0, 4).join('; ')}`);
                    const off = await ev(`[...document.querySelectorAll('#scheduler-detail .item-bar > *, .wf-page .item-bar > *, #history-session-view > .item-bar > *')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().left < -1 || e.getBoundingClientRect().right > innerWidth + 1)).map(e => (e.className || e.tagName).toString().slice(0, 24))`);
                    if (off.length) problems.push(`${where}: a control of the page's bar is off the screen ${off.join('; ')}`);
                    if (broken.length) problems.push(`${where}: words broken across lines ${broken.join('; ')}`);
                    if (SHOTS) { const s = await Page.captureScreenshot({ format: 'png' }); require('fs').writeFileSync(`${SHOTS}/sidebar-${name.replace(/[^a-z0-9]+/gi, '_')}-${label.replace(/[^a-z0-9]+/gi, '_')}-${theme}.png`, Buffer.from(s.data, 'base64')); }
                } catch (e) { problems.push(`${where}: the probe failed: ${String(e.message).slice(0, 240)}`); }
            }
        }
        for (const p of problems) console.log('[FAIL]', p);
        assert.deepEqual(problems, [], `${problems.length} problem(s)`);
        console.log('[PASS] Chats, Jobs, Workflows and Docs hold at 200% text and on a phone, in both themes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
