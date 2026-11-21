// A custom check waits for the Operator (#20139): the Needs you row shows the check in words, whole, with Approve and Deny, one click each. The click goes to the server's claim route (which runs it against the
// record the question was filed with); the page only shows the answer. The route is stubbed with the server's shape (the Go tests read the real one); a real isolated server serves the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

const WORDS = '@Operator [Coral] A custom check waits for your approval: stale-prs.\nRun the script "/Users/me/checks/stale.sh" (SHA-256 ' + 'ab12'.repeat(16) + ') with the arguments [1] "--days" [2] "7", in the folder "/Users/me/repo", every 30 minutes. Its lines go to the Orchestrator as automated notices. It runs as Dev: whatever it reads from this board it reads as Dev, who did not necessarily add this check. It can only read: it cannot post, add a task or change anything. Files the script reads or runs itself are not covered by this approval.\nApprove it only if you recognise this exact script. Deny removes the check.';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            const at = `${w}: `;
            await ev(`(() => {
                const buttons = [{ id: 7, label: 'Approve', action: 'approve-check', arg: 'stale-prs:hash', state: 'pending' }, { id: 8, label: 'Deny', action: 'deny-check', arg: 'stale-prs:hash', state: 'pending' }];
                window.__asks = [{ board: 'team', kind: 'ask', id: 41, key: 41, asker: 'Coral', text: ${JSON.stringify(WORDS)}, buttons, at: '2026-11-21T01:00:00Z' }];
                window.__claims = []; window.__mode = 'approved'; const orig = window.fetch.bind(window);
                const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const url = String(u);
                    if (url === '/api/operator-asks') return json(window.__asks);
                    const m = url.match(/\\/asks\\/41\\/buttons\\/(\\d+)\\/claim$/);
                    if (m) { window.__claims.push(Number(m[1]));
                        if (window.__mode === 'changed') { window.__asks = []; return json({ code: 'check_changed', message: 'the check changed since this question was filed: look at the new question' }, 409); }
                        window.__asks = []; return json({ ok: true, ran: true, result: Number(m[1]) === 7 ? 'approved' : 'denied', action: Number(m[1]) === 7 ? 'approve-check' : 'deny-check' }); }
                    return orig(u, o); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'one row in Needs you', 10000);
            const row = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr'); return { text: r.textContent, approve: !!r.querySelector('[data-check-action=approve]'), deny: !!r.querySelector('[data-check-action=deny]'), more: !!r.querySelector('.inbox-ask-expand') }; })()`);
            assert.ok(row.text.includes('SHA-256 ' + 'ab12'.repeat(16)), at + 'the SHA-256 is on the row: ' + row.text.slice(0, 200));
            assert.ok(row.text.includes('"--days"') && row.text.includes('/Users/me/repo'), at + 'the arguments and the folder are on the row');
            assert.ok(row.text.includes('runs as Dev') || row.text.includes('It runs as Dev'), at + 'who it runs as, in words');
            assert.ok(row.text.includes('It can only read'), at + 'the may-write answer, in words');
            assert.ok(row.approve && row.deny, at + 'Approve and Deny are in the row');
            assert.ok(!row.more, at + 'the words are shown whole, with no Show all to miss');
            // Approve: one click, one claim of the Approve button, the row goes
            await ev(`document.querySelector('[data-check-action=approve]').click(); true`);
            await waitFor(`window.__claims.length === 1`, at + 'the claim was sent', 8000);
            assert.deepEqual(await ev(`window.__claims`), [7], at + 'the Approve button (7) was claimed, once');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 0`, at + 'the answered row leaves Needs you', 8000);
            // Deny
            await ev(`window.__claims = []; window.__asks = [{ board: 'team', kind: 'ask', id: 41, key: 41, asker: 'Coral', text: ${JSON.stringify(WORDS)}, buttons: [{ id: 7, label: 'Approve', action: 'approve-check', arg: 'a:b', state: 'pending' }, { id: 8, label: 'Deny', action: 'deny-check', arg: 'a:b', state: 'pending' }], at: '2026-11-21T01:00:00Z' }]; window.__m = null; true`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            await waitFor(`document.querySelector('[data-check-action=deny]')`, at + 'the row is back', 8000);
            await ev(`document.querySelector('[data-check-action=deny]').click(); true`);
            await waitFor(`window.__claims.length === 1`, at + 'deny claimed', 8000);
            assert.deepEqual(await ev(`window.__claims`), [8], at + 'the Deny button (8) was claimed');
            // A check that changed: the server refuses with check_changed and the page drops the old row
            await ev(`window.__claims = []; window.__mode = 'changed'; window.__asks = [{ board: 'team', kind: 'ask', id: 41, key: 41, asker: 'Coral', text: ${JSON.stringify(WORDS)}, buttons: [{ id: 7, label: 'Approve', action: 'approve-check', arg: 'a:b', state: 'pending' }, { id: 8, label: 'Deny', action: 'deny-check', arg: 'a:b', state: 'pending' }], at: '2026-11-21T01:00:00Z' }]; true`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            await waitFor(`document.querySelector('[data-check-action=approve]')`, at + 'the row is back again', 8000);
            await ev(`document.querySelector('[data-check-action=approve]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 0`, at + 'a changed check leaves no stale Approve', 8000);
            // no horizontal scroll at this width
            assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), true, at + 'no horizontal scroll');
        }
        console.log('PASS a custom check is approved or denied from its Needs you row in one click');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
