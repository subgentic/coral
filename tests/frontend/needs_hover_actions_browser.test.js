// Gmail's hover actions on a wide Needs you (#11669, the operator): with a pointer a row shows its action buttons only at its hover or while focus is inside it, in their own slots (the same x on every row, #11630); the rest
// of the time that space shows how long the row has waited, and the Waiting column is gone. The buttons stay in the Tab order and in the page for a screen reader (transparent, not removed). A touch screen (hover: none) and a
// phone keep the buttons drawn and the Waiting column. Review rows (one read, one starred) stubbed in the page. 1440 with a mouse, 1440 as touch, 390. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'hover-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile, hover] of [[1440, 800, false, 'hover'], [1440, 800, true, 'none'], [390, 800, true, 'none']]) {
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
            const rowState = n => ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes('plan-${n}.md')), box = tr.querySelector('.inbox-review-actions'), when = tr.querySelector('.inbox-row-when'), approve = tr.querySelector('button[aria-label="Approve: plan-${n}.md"]');
                return { actions: Number(getComputedStyle(box).opacity), when: when ? Number(getComputedStyle(when).opacity) : null, whenText: when ? when.textContent : '', tab: approve.tabIndex, shown: approve.getClientRects().length > 0, x: Math.round(approve.getBoundingClientRect().left), y: Math.round(tr.getBoundingClientRect().top + tr.getBoundingClientRect().height / 2) }; })()`);
            const heads = await ev(`[...document.querySelectorAll('${T} thead th')].map(t => t.textContent.trim())`);
            if (hover === 'hover') {
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 }); await ev(framesJs(3)); // the pointer is nowhere near a row
                const idle = [await rowState(1), await rowState(2), await rowState(3)];
                check(idle.every(r => r.actions === 0 && r.when === 1 && /waiting/.test(r.whenText)), at + 'at rest the actions are transparent and the waiting time is shown: ' + JSON.stringify(idle));
                check(idle.every(r => r.tab === 0 && r.shown), at + 'the buttons stay in the Tab order and in the page while transparent');
                check(new Set(idle.map(r => r.x)).size === 1, at + 'the buttons are in the same slot on every row: ' + JSON.stringify(idle.map(r => r.x)));
                check(!heads.includes('Waiting') && heads.includes('Actions'), at + 'the Waiting column is gone: ' + JSON.stringify(heads));
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: idle[1].x + 20, y: idle[1].y }); await ev(framesJs(3));
                await shot('needs-hover-actions-1440');
                const over = [await rowState(1), await rowState(2), await rowState(3)];
                check(over[1].actions === 1 && over[1].when === 0, at + 'hovering a row shows its actions and hides its time: ' + JSON.stringify(over[1]));
                check(over[0].actions === 0 && over[2].actions === 0, at + 'the other rows stay at rest');
                // a click on a row's three dots, then the pointer moves to another row: the clicked row goes back to rest (no highlight, no buttons), the way it was before the click (the operator, #11800)
                const dotsAt = await ev(`(() => { const b = document.querySelector('${T} .inbox-row-more-toggle'), r = b.getBoundingClientRect(); return { n: b.getAttribute('aria-label').replace(/^.*(plan-\\d).*$/, '$1'), x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: dotsAt.x, y: dotsAt.y });
                for (const type of ['mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: dotsAt.x, y: dotsAt.y, button: 'left', clickCount: 1 });
                await waitFor(`!!document.querySelector('${T} .menu:not([hidden])')`, at + 'the three dots open', 5000);
                for (const type of ['mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: dotsAt.x, y: dotsAt.y, button: 'left', clickCount: 1 }); // the same button again closes it
                await waitFor(`!document.querySelector('${T} .menu:not([hidden])')`, at + 'and close', 5000);
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: idle[2].x + 20, y: idle[2].y }); await ev(framesJs(3));
                const after = [await rowState(dotsAt.n.slice(-1)), await rowState(3)], lit = await ev(`[...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes('${dotsAt.n}.md')).getAttribute('aria-current')`);
                check(after[0].actions === 0 && after[1].actions === 1, at + 'after the dots were clicked and the pointer moved on, only the hovered row shows its actions: ' + JSON.stringify(after));
                check(lit !== 'true', at + 'and the clicked row is not left as the current row: ' + lit);
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 }); await ev(framesJs(3));
                await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft' }); // a key press: the focus that follows is the keyboard's (:focus-visible), as a Tab's would be
                await ev(`document.querySelector('${T} button[aria-label="Approve: plan-3.md"]').focus(); true`); await ev(framesJs(3));
                const focus = [await rowState(1), await rowState(3)];
                check(focus[1].actions === 1 && focus[1].when === 0 && focus[0].actions === 0, at + 'keyboard focus inside a row shows its actions: ' + JSON.stringify(focus));
            } else {
                const all = [await rowState(1), await rowState(2), await rowState(3)];
                check(all.every(r => r.actions === 1 && r.when === null), at + 'the buttons are drawn and there is no hover time: ' + JSON.stringify(all));
                check(heads.includes('Waiting') || mobile, at + 'the Waiting column stays on touch: ' + JSON.stringify(heads));
            }
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_hover_actions_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
