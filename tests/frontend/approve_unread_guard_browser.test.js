// Approving a file nobody opened asks first (#11999, the operator: a stray click on the hover-only button approved a report unread): an unread row's Approve opens 'Approve without opening?' with Approve and 'Open it first'
// (which opens the viewer, as does Escape); a read row approves as before. The question panel ('<agent> asks you') is centred and in the page font. Rows plan-1 and plan-3 unread, plan-2 read. 1440 with a mouse and 390.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'guard-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile, hover] of [[1440, 800, false, 'hover'], [390, 800, true, 'none']]) {
            const at = `${w} px, ${hover === 'hover' ? 'a mouse' : 'touch'}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, tags) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags, produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = [item(1, ['for review']), item(2, ['for review', 'read']), item(3, ['for review'])];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, at + 'three review rows', 15000);
            await ev(framesJs(4));
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);
            const modal = () => ev(`(() => { const m = document.getElementById('confirm-modal'); return m && getComputedStyle(m).display !== 'none' ? { title: document.getElementById('confirm-modal-title').textContent, yes: document.getElementById('confirm-modal-yes').textContent, no: document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').textContent } : null; })()`);
            const press = n => ev(`(() => { const b = document.querySelector('${T} button[aria-label="Approve: plan-${n}.md"]'); if (b.closest('.inbox-actions-hover')) b.closest('tr').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); b.click(); return true; })()`);
            await press(1); await ev(framesJs(3));
            const ask = await modal();
            check(ask && ask.title === 'Approve without opening?' && ask.yes === 'Approve' && ask.no === 'Open it first', at + 'Approve on an unread file asks: ' + JSON.stringify(ask));
            check(await ev(`!!document.querySelector('${T} button[aria-label="Approve: plan-1.md"]')`), at + 'and the row is still there while it asks');
            await shot('approve-unread-asks-' + w);
            await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`); await ev(framesJs(3));
            check(!(await modal()), at + 'Open it first closes the question');
            await waitFor(`/plan-1\\.md/.test(document.getElementById('artifact-viewer-title')?.textContent || '') && document.getElementById('artifact-viewer-title').getClientRects().length > 0`, at + 'Open it first opens the file in the viewer', 10000).catch(() => check(false, at + 'Open it first opens the file in the viewer (it did not appear)'));
            await ev(`history.back(); true`); await ev(framesJs(4));
            await press(2); await ev(framesJs(3));
            check(!(await modal()), at + 'Approve on a read file does not ask');
            if (!mobile) {
                const panel = await ev(`import(${S} + 'operator_asks.js').then(m => { m.openAskDialog({ asker: 'Orchestrator', board: 'x', board_label: 'sprout', kind: 'wait', text: 'Do you accept it so I can close goal #1? I recommend yes.' }); const d = document.querySelector('dialog.inbox-ask-dialog'), r = d.getBoundingClientRect(), pre = d.querySelector('.inbox-ask-text'); const out = { left: Math.round(r.left), right: Math.round(innerWidth - r.right), top: Math.round(r.top), bottom: Math.round(innerHeight - r.bottom), mono: /mono|courier/i.test(getComputedStyle(pre).fontFamily), font: getComputedStyle(pre).fontFamily }; d.close(); d.remove(); return out; })`);
                check(Math.abs(panel.left - panel.right) <= 2 && Math.abs(panel.top - panel.bottom) <= 2 && panel.left > 20, at + 'the question panel is centred: ' + JSON.stringify(panel));
                check(!panel.mono, at + 'the question text is in the page font, not monospace: ' + panel.font);
            }
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('approve_unread_guard_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
