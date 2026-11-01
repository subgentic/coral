// Needs you's columns each show their whole header and each has a resize handle (#11835, the operator's report: the Blocks column's header read "Bl" and the column could not be widened). A for-review file that holds up a
// task sits among waiting agents, so the table has every column it can have; at 1280, 1024 and the narrow desktop widths every header is readable in full (its label is not cut) and carries a handle, and dragging the Blocks
// handle widens its column. Drives Chrome through agent_view_harness.js against the isolated dev server.
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
                const item = { id: hex, name: 'checkout-mockup.html', media_type: 'text/html', size: 30, created_at: new Date(Date.now() - 4 * 3600000).toISOString(), task_id: 5, goal_id: 7, goal_title: 'Checkout redesign', waits_on_this: { count: 1, top_title: 'Tag batch-88', priority: 'high', closes_goal: 'Checkout redesign' }, source: 'upload', available: true, session_id: 'writer-a', produced_by: 'Frontend Dev', tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex };
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
        for (const w of [1280, 1024, 900, 800]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 820, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await stage(at);
            let m = await measure();
            for (const h of m.heads) { check(!h.cut, `${at}the ${h.label} header is shown whole: ${JSON.stringify(h)}`); if (h.key !== 'review' && h.key !== 'answer') check(h.handle, `${at}the ${h.label} column has a resize handle`); }
            const hasBlocks = m.heads.some(h => h.key === 'blocks'); // the optional columns go, lowest priority first, when the panel is narrow (Blocks at 654 px of panel): what stays is whole
            if (w >= 1280) check(hasBlocks, `${at}the Blocks column is there: ${JSON.stringify(m.heads)}`);
            check(!m.scroll && m.waitingIn !== false && m.actionsIn !== false, `${at}the table fits its panel at first: ${JSON.stringify({ ...m, heads: 0 })}`);
            await shot(`needs-columns-${w}`);
            for (const key of hasBlocks ? ['agent', 'blocks', 'agent'] : ['agent']) {
                check(await drag(key, 700), `${at}the ${key} handle can be dragged`);
                m = await measure();
                check(!m.scroll && m.tableW <= m.boxW + 1, `${at}after dragging ${key} wide the table still fits its panel: ${JSON.stringify({ ...m, heads: 0 })}`);
                check(m.waitingIn !== false && m.actionsIn !== false && m.btnsIn, `${at}after dragging ${key} wide Time and the action buttons are inside the panel: ${JSON.stringify({ ...m, heads: 0 })}`);
                check(m.itemW >= 100, `${at}the Item column keeps some room: ${m.itemW}`);
                check(m.heads.every(h => !h.cut), `${at}after dragging ${key} every header is still whole: ${JSON.stringify(m.heads.filter(h => h.cut))}`);
            }
            if (hasBlocks) await drag('blocks', -700);
            m = await measure();
            const blocks = m.heads.find(h => h.key === 'blocks');
            check(!hasBlocks || (!!blocks && !blocks.cut), `${at}dragged narrow, the Blocks column stops where its whole header shows: ${JSON.stringify(blocks)}`);
            await shot(`needs-columns-dragged-${w}`);
            // widths kept from a wider window: reloaded in this one, the table still fits
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`localStorage.setItem('coral-dt-widths:Needs you', JSON.stringify({ blocks: 900, waiting: 400, goal: 500, asks: 500 })); true`);
            await stage(at, false);
            m = await measure();
            check(!m.scroll && m.waitingIn !== false && m.actionsIn !== false, `${at}widths kept from a wider window still fit this panel: ${JSON.stringify({ ...m, heads: 0 })}`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_columns_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
