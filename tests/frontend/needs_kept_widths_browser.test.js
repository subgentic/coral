// A width kept from 2.0.27 never leaves Needs you with a narrow Item and an empty middle (#11886, the operator's report: Item at 250 px with its names cut while the Blocks column took the empty middle, and the pills read
// "All 0 / For review 0" over listed For review rows: the pills are a separate question, the pills say 'For review 0 of 2' for a list whose rows are all read, the operator's ruling). Widths kept as the operator had them (Item 250, Blocks 64, Waiting 90) are fitted on load: the name column takes what the others leave, Blocks shows its whole header, the
// table fits its panel; an over-wide kept layout is fitted, never scrolled off. The files are page stubs (all read). 1440, 1280 and 1024 px.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

const iso = ms => new Date(Date.now() - ms).toISOString();
const _agent = (i, name) => ({ name: 'n' + i, session_id: `0000000${i}-0000-4000-8000-00000000000${i}`, agent_type: 'claude', server: 'local', status: 'idle', display_name: name, working_directory: '/repo/n' + i, waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./...', waiting_since: iso(600000 + i * 1000), waits_on_this: { count: 3, top_title: 'Tag v2.0.10', priority: 'high' } });
const AGENTS = []; // the operator's table is files for review and questions: no agent rows (their Answer column is a second wide one)

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const team = 'cols-' + Date.now().toString(36), T = '#group-table-view';
    const measure = async () => { await ev(framesJs(4)); return ev(`(() => { const box = document.querySelector('${T} .dt-box') || document.querySelector('${T}'), br = box.getBoundingClientRect(), table = box.querySelector('table'), ths = [...box.querySelectorAll('thead th.dt-th')].filter(th => th.getClientRects().length && !th.classList.contains('dt-col-unused') && !th.classList.contains('dt-col-tight'));
        const r = e => e.getBoundingClientRect();
        const named = k => ths.find(th => th.dataset.key === k);
        const heads = ths.map(th => { const lab = th.querySelector('.dt-sort > span, .dt-head-text'); return { key: th.dataset.key, w: Math.round(r(th).width), label: lab ? lab.textContent : '', cut: !!lab && !th.querySelector('.sr-only') && (lab.getBoundingClientRect().right > r(th).right - 9), handle: !!th.querySelector('.dt-resize') }; });
        const tds = [...box.querySelectorAll('tbody tr:first-child td')].filter(td => td.getClientRects().length), last = tds[tds.length - 1], wait = named('waiting'), act = named('review');
        return { boxW: Math.round(br.width), tableW: Math.round(r(table).width), scroll: box.scrollWidth > box.clientWidth + 1, heads, itemW: named('agent') ? Math.round(r(named('agent')).width) : 0,
            waitingIn: wait ? r(wait).right <= br.right + 1 : null, actionsIn: act ? r(act).right <= br.right + 1 : null, lastIn: last ? r(last).right <= br.right + 1 : null, btnsIn: [...box.querySelectorAll('tbody .inbox-review-actions button')].filter(b => b.getClientRects().length).every(b => r(b).right <= br.right + 1) }; })()`); };
    const handle = key => ev(`(() => { const h = document.querySelector('${T} thead th[data-key="${key}"] .dt-resize'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const drag = async (key, dx) => { const p = await handle(key); if (!p) return false; const I = client.Input, mv = (type, x, extra = {}) => I.dispatchMouseEvent({ type, x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
        await I.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await mv('mousePressed', p.x); for (let i = 1; i <= 10; i++) await mv('mouseMoved', p.x + dx * i / 10); await mv('mouseReleased', p.x + dx); return true; };
    const stage = async (at, clear = true) => {
        await ev(INBOX_WORLD);
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Review Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(AGENTS)}; m.updateInboxTab();
                const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = (1).toString(16).padStart(64, '0');
                const item = { id: hex, name: 'checkout-mockup.html', media_type: 'text/html', size: 30, created_at: new Date(Date.now() - 4 * 3600000).toISOString(), task_id: 5, goal_id: 7, goal_title: 'Checkout redesign', waits_on_this: { count: 1, top_title: 'Tag batch-88', priority: 'high', closes_goal: 'Checkout redesign' }, source: 'upload', available: true, session_id: 'writer-a', produced_by: 'Frontend Dev', tags: ['for review', 'read'], uri: 'coral://artifacts/' + hex };
                const item2 = { ...item, id: (2).toString(16).padStart(64, '0'), name: 'security-design-note.md', waits_on_this: undefined, task_id: 6, uri: 'coral://artifacts/' + (2).toString(16).padStart(64, '0'), created_at: new Date(Date.now() - 2 * 3600000).toISOString() };
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? [item, item2] : [], has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); ${clear ? "localStorage.removeItem('coral-dt-widths:Needs you');" : ''} window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].some(r => r.textContent.includes('checkout-mockup.html')) && !!document.querySelector('${T} thead th[data-key="blocks"]')`, at + 'the table', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [1440, 1280, 1024]) for (const kept of [{ agent: 250, blocks: 64, waiting: 90 }, { agent: 1200, blocks: 900, waiting: 400, asks: 500 }]) {
            const at = `${w} px, kept ${JSON.stringify(kept)}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 820, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`localStorage.setItem('coral-dt-widths:Needs you', ${JSON.stringify(JSON.stringify(kept))}); true`);
            await stage(at, false);
            let m = await measure();
            check(!m.scroll && m.waitingIn !== false && m.actionsIn !== false && m.btnsIn, at + 'the kept layout fits the panel: ' + JSON.stringify({ ...m, heads: 0 }));
            const item = m.heads.find(h => h.key === 'agent'), others = m.heads.filter(h => h.key !== 'agent').reduce((n, h) => n + h.w, 0);
            check(!!item && item.w >= m.boxW - others - 4, at + 'the name column takes what the others leave (no empty middle): ' + JSON.stringify({ item: item && item.w, others, box: m.boxW }));
            if (kept.agent === 250 && w >= 1280) check(!!item && item.w > 300, at + 'the name column is wider than the 250 px kept for it (it was left at 250 with an empty middle): ' + (item && item.w));
            for (const h of m.heads) check(!h.cut, at + `the ${h.label} header is whole: ` + JSON.stringify(h));
            const pills = await ev(`[...document.querySelectorAll('${T} button.goals-chip, #group-table-view button.goals-chip')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
            check(pills.includes('All 0 of 2') && pills.includes('For review 0 of 2'), at + 'the pills say how many rows are listed when read ones are in them (one number, and the list\'s size): ' + JSON.stringify(pills));
            if (kept.agent === 250) await shot(`needs-kept-widths-${w}`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_kept_widths_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
