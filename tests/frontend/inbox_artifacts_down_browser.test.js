// A registered computer that is hung (#8904, hub walk on run 134): with Box Two accepting the connection and never answering, the hub's Inbox Artifacts folder used to stay on "Loading artifacts…" for
// ever and list none of the reachable computers' files. Each registered computer's read now has a time limit: this computer's file is listed at once the limit is up, a quiet line says "Box Two did not
// answer, so its artifacts are not shown." with a Retry, and Retry asks again (Box Two then answers and both files are listed, the line gone). Box Two's read is a stub that never settles until released.
// 1280 and 390. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
const path = require('node:path');

const art = (id, name) => ({ id: id.repeat(64), name, media_type: 'text/markdown', size: 1000, created_at: '2026-10-26T10:00:00Z', task_id: 7, task_title: 'A task', source: 'task', uri: 'coral://artifacts/' + id.repeat(64), available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha' });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-inbox-') || k.startsWith('coral-saved-filters')) localStorage.removeItem(k); } catch {} true`);
            await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Box Two', status: 'online' }];
                window.__boxTwoUp = false; const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.href), remote = url.pathname.startsWith('/api/remote/box-2/'), p = url.pathname.replace(/^\\/api\\/remote\\/box-2/, '');
                    if (p === '/api/goals') {
                        if (remote && !window.__boxTwoUp) return new Promise((_, reject) => { if (o.signal) o.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
                        return json({ goals: [{ id: 1, board_id: 'alpha', title: remote ? 'Remote goal' : 'Local goal', state: 'active', rollup: { total: 1, done: 0 } }] });
                    }
                    if (p === '/api/team-artifacts') {
                        if (remote) window.__remoteReads = (window.__remoteReads || 0) + 1;
                        if (remote && !window.__boxTwoUp) return new Promise((_, reject) => { if (o.signal) o.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }); // hung: accepts, never answers
                        return json({ artifacts: [remote ? ${JSON.stringify(art('b', 'remote-report.md'))} : ${JSON.stringify(art('a', 'local-report.md'))}], limit: 100, offset: 0, has_more: false, truncated: false, total: 1, all: 1, teams: [{ board_id: 'alpha', team: 'alpha', all: 1 }] });
                    }
                    if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
                    if (remote) return json({}); return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, `${label}: the folders`, 10000);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = 'artifacts'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="artifacts"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 1`, `${label}: this computer's file, after Box Two's time limit (one wait of 8 s, not one per redraw)`, 12000);
            await settle(300);
            const down = await ev(`({ rows: [...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ')), line: ((document.querySelector('.team-artifacts-down') || {}).textContent || '').trim(), retry: !!document.querySelector('.team-artifacts-down-retry'), loading: /Loading artifacts/.test(document.getElementById('group-table-view').textContent) })`);
            check(`${label}: with Box Two hung, this computer's file is listed and the page is not stuck on Loading`, down.rows.length === 1 && /local-report/.test(down.rows[0]) && !down.loading, JSON.stringify(down));
            check(`${label}: Box Two was asked twice at most (the sidebar's count and the page), not again at every redraw`, (await ev(`window.__remoteReads`)) <= 2, String(await ev(`window.__remoteReads`)));
            check(`${label}: a quiet line says Box Two did not answer, with a Retry`, /^Box Two did not answer, so its artifacts are not shown\.$/.test(down.line) && down.retry && await ev(`document.querySelector('.team-artifacts-down-retry').getBoundingClientRect().width < 160`), JSON.stringify(down));
            await shot(`inbox-artifacts-down-${label}`);
            await ev(`window.__boxTwoUp = true; document.querySelector('.team-artifacts-down-retry').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2`, `${label}: both files after Retry`, 10000);
            const after = await ev(`({ rows: document.querySelectorAll('#group-table-view tbody tr').length, line: !!document.querySelector('.team-artifacts-down') })`);
            check(`${label}: Retry asks again: Box Two answers, both files are listed and the line is gone`, after.rows === 2 && !after.line, JSON.stringify(after));
            // Goals (the same limit and the same quiet line): this computer's goal is listed, Box Two is named
            await ev(`window.__boxTwoUp = false; true`);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = 'goals'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="goals"]').click(); true`);
            await waitFor(`!!document.querySelector('.group-table-note') && /Box Two did not answer/.test(document.querySelector('.group-table-note').textContent)`, `${label}: Goals names Box Two after its time limit`, 20000);
            const gl = await ev(`({ rows: [...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ')), note: document.querySelector('.group-table-note').textContent.trim() })`);
            check(`${label}: Goals lists this computer's goal and says "Box Two did not answer, so its goals are not shown."`, gl.rows.length === 1 && /Local goal/.test(gl.rows[0]) && gl.note === 'Box Two did not answer, so its goals are not shown.', JSON.stringify(gl));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox artifacts down-computer checks passed`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
