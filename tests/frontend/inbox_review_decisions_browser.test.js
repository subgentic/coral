// Deny and Ignore on a review row of Needs you (#11552, the approved action set): Deny opens "Deny this?" with an optional reason (Cancel sends nothing), sends { decision: 'deny', reason } and the row leaves; Ignore sends { decision: 'ignore' }
// and says so with Undo, which sends { decision: 'unignore' } and the row is back; neither posts anything else (no message, no comment: the silent rule); each keeps the person's place (scroll, focus on the next row). 1440 (the four words)
// and 390 (the phone: Deny and Ignore are in the row's three dots). 30 review rows, the team's artifact list and the review route stubbed in the page, as the Lead's server answers.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'decide-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const S = `(window.__coralStatic || '/static/')`;
    const N = 30;
    const name = i => 'plan-' + String(i).padStart(2, '0') + '.md';
    const SCROLLER = `(() => { for (let e = document.querySelector('${T} tbody'); e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 1) return e; } return document.scrollingElement; })()`;
    const state = () => ev(`(() => { const s = ${SCROLLER}, rows = [...document.querySelectorAll('${T} tbody tr')], a = document.activeElement, tr = a && a.closest ? a.closest('tr') : null;
        return { top: Math.round(s.scrollTop), names: rows.map(r => (r.textContent.match(/plan-\\d+\\.md/) || [''])[0]), focusRow: tr ? (tr.textContent.match(/plan-\\d+\\.md/) || [''])[0] : '' }; })()`);
    const toRow = n => ev(`document.querySelector('${T} button[aria-label="Approve: ${name(n)}"]').scrollIntoView({ block: 'center' }); true`);
    const calls = () => ev(`window.__calls`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 700, false], [390, 700, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i), name: 'plan-' + String(i).padStart(2, '0') + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (${N} - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), produced_by: 'Plan Writer', session_id: 's' + i });
                window.__items = Array.from({ length: ${N} }, (_, k) => item(k + 1)); window.__calls = [];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase(), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                    if (method !== 'GET' && /^\\/api\\/board\\//.test(u.pathname)) window.__calls.push({ method, path: u.pathname.replace('/api/board/${team}', ''), body: opts.body ? JSON.parse(opts.body) : null });
                    if (!m) return original(url, opts);
                    if (!m[1]) return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    const it = window.__items.find(a => a.id === m[1]), body = opts.body ? JSON.parse(opts.body) : {};
                    if (m[2] === 'review') {
                        const strip = t => it.tags.filter(x => x !== t);
                        if (body.decision === 'deny') { it.tags = strip('for review').concat('denied'); return json({ id: it.id, state: 'denied', delivered: true, to: 'Plan Writer', review: { state: 'denied', at: new Date().toISOString() } }); }
                        if (body.decision === 'ignore') { it.tags = strip('for review').concat('ignored'); return json({ id: it.id, delivered: false, tags: it.tags }); }
                        if (body.decision === 'unignore') { it.tags = strip('ignored').concat('for review'); return json({ id: it.id, delivered: false, tags: it.tags }); }
                        it.tags = strip('for review').concat('approved'); return json({ id: it.id, state: 'approved', delivered: true, to: 'Plan Writer', review: { state: 'approved', at: new Date().toISOString() } });
                    }
                    return json({ id: it.id, tags: it.tags }); };
                return true; })()`);
            await ev(`localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' })); window.switchNavTab('hub-inbox'); true`); // oldest first: plan-01 first
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === ${N}`, at + 'thirty review rows', 15000);
            await ev(framesJs(3));
            // the control of an action: a word on the 1440 row, an item of the row's three dots on the phone
            const press = async (n, word) => {
                if (mobile) {
                    await ev(`document.querySelector('${T} button[aria-label="More actions for ${name(n)}"]').click(); true`);
                    await waitFor(`document.querySelector('${T} .inbox-row-more-toggle[aria-expanded="true"]')`, at + 'the three dots open', 4000);
                    await ev(`document.querySelector('${T} .menu-item[aria-label="${word}: ${name(n)}"]').click(); true`);
                } else await ev(`document.querySelector('${T} button[aria-label="${word}: ${name(n)}"]').click(); true`);
            };

            // Deny: Cancel sends nothing
            await toRow(10); await ev(framesJs(3)); await press(10, 'Deny');
            await waitFor(`document.querySelector('dialog.inbox-deny-dialog[open]')`, at + 'the Deny dialog opens', 4000);
            check(await ev(`document.querySelector('dialog.inbox-deny-dialog h2').textContent === 'Deny ${name(10)}?' && !!document.querySelector('dialog.inbox-deny-dialog textarea') && document.activeElement.tagName === 'TEXTAREA'`), at + 'the dialog asks "Deny plan-10.md?" with a reason box, focused');
            await ev(`[...document.querySelectorAll('dialog.inbox-deny-dialog button')].find(b => b.textContent === 'Cancel').click(); true`);
            await waitFor(`!document.querySelector('dialog.inbox-deny-dialog')`, at + 'Cancel closes it', 4000);
            check((await calls()).length === 0 && (await state()).names.includes(name(10)), at + 'Cancel sends nothing and the row stays: ' + JSON.stringify(await calls()));

            // Deny with a reason: sent, the row leaves, the place is kept
            await toRow(10); await ev(framesJs(3)); const before = await state();
            await press(10, 'Deny');
            await waitFor(`document.querySelector('dialog.inbox-deny-dialog[open]')`, at + 'the Deny dialog opens again', 4000);
            await ev(`const t = document.querySelector('dialog.inbox-deny-dialog textarea'); t.value = 'Not what we asked for'; t.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('dialog.inbox-deny-dialog button')].find(b => b.textContent === 'Deny').click(); true`);
            await waitFor(`!document.querySelector('${T} button[aria-label="Approve: ${name(10)}"]')`, at + 'the denied row leaves', 8000).catch(() => {});
            await ev(framesJs(6)); const afterDeny = await state();
            const denied = (await calls()).filter(c => c.path.endsWith('/review'));
            check(denied.length === 1 && denied[0].body.decision === 'deny' && denied[0].body.reason === 'Not what we asked for', at + 'one review call: deny with the reason: ' + JSON.stringify(denied));
            check(!afterDeny.names.includes(name(10)) && Math.abs(afterDeny.top - before.top) <= 80 && afterDeny.focusRow === name(11), at + 'Deny keeps the place: scroll ' + before.top + ' to ' + afterDeny.top + ', focus on ' + JSON.stringify(afterDeny.focusRow));
            check(await ev(`!![...document.querySelectorAll('.toast')].find(t => /Denied plan-10\\.md/.test(t.textContent))`), at + 'a toast says it was denied');

            // Ignore: sent with no reason, Undo in the toast
            await ev(`window.__calls = []; document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
            await toRow(15); await ev(framesJs(3)); const b2 = await state();
            await press(15, 'Ignore');
            await waitFor(`!document.querySelector('${T} button[aria-label="Approve: ${name(15)}"]')`, at + 'the ignored row leaves', 8000).catch(() => {});
            await ev(framesJs(6)); const afterIgnore = await state();
            const ignored = await calls();
            check(ignored.length === 1 && ignored[0].path.endsWith('/review') && ignored[0].body.decision === 'ignore' && !('reason' in ignored[0].body), at + 'one call: ignore, nothing else (no message, no comment): ' + JSON.stringify(ignored));
            check(!afterIgnore.names.includes(name(15)) && Math.abs(afterIgnore.top - b2.top) <= 80 && afterIgnore.focusRow === name(16), at + 'Ignore keeps the place: scroll ' + b2.top + ' to ' + afterIgnore.top + ', focus on ' + JSON.stringify(afterIgnore.focusRow));
            const toast = await ev(`(() => { const t = [...document.querySelectorAll('.toast')].find(x => /Ignored: plan-15\\.md/.test(x.textContent)); return t ? { undo: !!([...t.querySelectorAll('button')].find(b => b.textContent.trim() === 'Undo')) } : null; })()`);
            check(!!toast && toast.undo, at + 'a toast says "Ignored: plan-15.md" with Undo: ' + JSON.stringify(toast));
            await ev(`[...document.querySelectorAll('.toast')].find(x => /Ignored: plan-15/.test(x.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); }); true`);
            await waitFor(`!!document.querySelector('${T} button[aria-label="Approve: ${name(15)}"]')`, at + 'Undo brings the row back', 8000).catch(() => {});
            const all = await calls();
            check(all.length === 2 && all[1].body.decision === 'unignore' && all.every(c => c.path.endsWith('/review')), at + 'Undo sends unignore, and every call was the review route: ' + JSON.stringify(all));
            check((await state()).names.includes(name(15)), at + 'the row is back in the list');
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_review_decisions_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
