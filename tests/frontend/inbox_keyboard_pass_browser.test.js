// The Inbox and Settings by keyboard (Beta #10409, #10420): (1) the Inbox's folder list is one Tab stop with the arrows between its views, and says so (a description a screen reader reads: "Use the arrow keys..."); the
// Settings tab list likewise; (2) starring a chat from the keyboard keeps the keyboard on the star (it dropped to the page), the button is named Unstar once the chat is starred, and a polite status says "Starred";
// (3) pinned, not reproduced: the Saved list's Filters and Sort are not two stray Tab stops on the other Inbox pages; and the Alert-when switches are disabled while Desktop alerts is off. The mailbox suite's stubbed
// history (120 chats, the flags route recorded), one saved message. 1366 x 768. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const stub = () => ev(`(() => { const R = window.fetch; window.__asked = []; window.__flags = [];
        // Pin each bucket inside its calendar day: subtracting i minutes from now can erase Yesterday at 00:11–00:12, and 24-hour days drift across DST (#8578).
        const now = new Date();
        const stamp = i => { const d = new Date(now); d.setDate(d.getDate() - Math.floor(i / 12)); d.setHours(12, 59 - i % 12, 0, 0); return d.toISOString(); };
        const sessions = Array.from({ length: 120 }, (_, i) => ({ session_id: 'chat-' + String(i).padStart(3, '0'), type: i === 3 ? 'group' : 'agent', title: i === 3 ? 'release-crew' : 'Chat title ' + i, summary: i === 3 ? 'release-crew - 1 messages, 0 participants' : 'The snippet of chat ' + i, agent_name: ['Backend Dev', 'QA Engineer', 'Frontend Dev'][i % 3], display_name: ['Backend Dev', 'QA Engineer', 'Frontend Dev'][i % 3],
            last_timestamp: stamp(i), duration_sec: 600 + i * 30, source_type: i % 4 === 0 ? 'codex' : 'claude', starred: false, archived: i === 3, active: i === 1, tags: [] }));
        const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 119, group: 1, notes: 9, active: 1, starred: 0, archived: 3, by_agent_type: { claude: 90, codex: 30, agy: 27, antigravity: 27, gemini: 27 }, tags: [{ id: 7, name: 'release', color: '#e5534b', count: 4 }] });
            if (url.pathname === '/api/sessions/history' && window.__failBig && url.searchParams.get('page_size') === '200') { window.__asked.push(Object.fromEntries(url.searchParams)); return json({ error: 'down' }, 500); } // the unread recount's read, failing (#9703)
            if (url.pathname === '/api/sessions/history') { window.__asked.push(Object.fromEntries(url.searchParams)); const p = Number(url.searchParams.get('page') || 1), n = Number(url.searchParams.get('page_size') || 50); const ty = url.searchParams.get('type'), list = ty === 'group' ? sessions.filter(x => x.type === 'group') : ty === 'agent' ? sessions.filter(x => x.type !== 'group') : sessions; return json({ sessions: list.slice((p - 1) * n, p * n), total: list.length, page: p, page_size: n }); }
            if (/^\\/api\\/sessions\\/history\\/[^/]+\\/flags$/.test(url.pathname) && String(o.method).toUpperCase() === 'PATCH') { window.__flags.push([decodeURIComponent(url.pathname.split('/')[4]), JSON.parse(o.body)]); { const row = sessions.find(x => x.session_id === decodeURIComponent(url.pathname.split('/')[4])); if (row) Object.assign(row, JSON.parse(o.body)); } return json({ ok: true }); }
            return R(u, o); }; return true; })()`);
    const open = async (w, h, mobile, failBig = false) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Emulation.setTimezoneOverride({ timezoneId: 'Asia/Kolkata' }); // a clock whose morning is before the seeded 12:59 chats: the case a runner in UTC is in (#9864)
        await ev(`try { localStorage.removeItem('coral-last-place'); } catch (e) {} true`).catch(() => {}); // the dashboard reopens the chat the person left (#10057): a chat opened by an earlier step would be reopened, and read, on this load
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await ev(`window.__failBig = ${failBig}; true`); await stub();
        // the seeded chats are stamped at fixed hours of today: on a runner whose clock is before them they are in the future of a marker that began now and would count as unread. A first load with no marker gets one that began tomorrow, so nothing is unread whatever the hour (parts 6 and after set their own).
        await ev(`if (!localStorage.getItem('coral.inbox.read.v1')) localStorage.setItem('coral.inbox.read.v1', JSON.stringify({ since: Date.now() + 86400000, items: {} })); true`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 50`, 'the first page of chats', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open(1366, 768, false);
        await ev(`fetch('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent', ref: 'ref-10420', key: 'ab'.repeat(10), agent_type: 'claude', title: 'kb-saved', snippet: 'A saved message', said_at: '2026-10-17T08:00:00Z' }) }).then(r => r.status)`); // one saved message, so the Saved list has something to filter
        await ev(`window.switchNavTab('agents'); window.switchNavTab('hub-inbox'); true`); await new Promise(r => setTimeout(r, 800)); // sleep-ok: the Inbox reads the saved list again
        // (1) the folder list says how it moves
        const nav = await ev(`(() => { const n = document.querySelector('.view-list-nav'); const d = n && n.getAttribute('aria-describedby') && document.getElementById(n.getAttribute('aria-describedby')); return { stops: n ? [...n.querySelectorAll('button')].filter(b => b.tabIndex === 0).length : -1, desc: d ? d.textContent.trim() : '' }; })()`);
        check(nav.stops === 1, `the folder list is one Tab stop: ${JSON.stringify(nav)}`);
        check(/arrow keys/i.test(nav.desc), `and says to use the arrow keys (its description): ${JSON.stringify(nav.desc)}`);
        // (3) the Saved list's controls are not on the other pages (pinned: not reproduced; the Saved page has its own bar)
        const bar = () => ev(`(() => { const b = document.getElementById('inbox-saved-bar'); return !!b && [...b.querySelectorAll('button, select')].some(e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'); })()`);
        check(!(await bar()), 'the Saved list\'s Filters and Sort are not shown on All chats');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await new Promise(r => setTimeout(r, 600)); // sleep-ok: the page draws
        check(!(await bar()), 'and not on Needs you');
        // (2) star by keyboard
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 50`, 'the chats', 15000);
        const star = () => ev(`(() => { const b = document.querySelector('#group-table-view .dt-flag[aria-label^="Star"], #group-table-view .dt-flag[aria-label^="Unstar"]'); return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') } : null; })()`);
        const before = await star();
        check(before && /^Star: /.test(before.label), `a chat that is not starred offers Star: ${JSON.stringify(before)}`);
        await ev(`document.querySelector('#group-table-view .dt-flag[aria-label^="Star"]').focus(); window.__row = document.querySelector('#group-table-view .dt-flag[aria-label^="Star"]').closest('tr').dataset.key; true`);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the flag is saved and the list is drawn again
        const after = await ev(`(() => { const a = document.activeElement; return { body: a === document.body, label: a && a.getAttribute && a.getAttribute('aria-label'), sameRow: !!a && !!a.closest && !!a.closest('tr') && a.closest('tr').dataset.key === window.__row, said: ((document.getElementById('notice-live') || {}).textContent || '').trim() }; })()`);
        check(!after.body && /^Unstar: /.test(after.label || '') && after.sameRow, `after Enter the keyboard is on the same chat's star, now named Unstar: ${JSON.stringify(after)}`);
        check(/Starred/.test(after.said), `a polite status says Starred: ${JSON.stringify(after.said)}`);
        // (1b) the Settings tab list
        await ev(`window.showSettingsModal(); true`); await new Promise(r => setTimeout(r, 1000)); // sleep-ok: the dialog fills
        const tabs = await ev(`(() => { const t = document.querySelector('#settings-modal [role=tablist]'); const d = t && t.getAttribute('aria-describedby') && document.getElementById(t.getAttribute('aria-describedby')); return { desc: d ? d.textContent.trim() : '' }; })()`);
        check(/arrow keys/i.test(tabs.desc), `the Settings tab list says to use the arrow keys: ${JSON.stringify(tabs)}`);
        // (4) pinned: the Alert-when switches are off-limits while Desktop alerts is off
        const alerts = await ev(`['settings-alert-needs-input', 'settings-alert-reply'].map(id => { const e = document.getElementById(id); return e ? e.disabled : null; })`);
        check(alerts.every(d => d === true), `the Alert-when switches are disabled while Desktop alerts is off: ${JSON.stringify(alerts)}`);
    } finally {
        try { const items = await ev(`fetch('/api/saved?state=all&limit=1000').then(r => r.json()).then(j => (j.items || []).map(i => i.id))`); for (const id of items) await ev(`fetch('/api/saved/' + ${id}, { method: 'DELETE' }).then(r => r.status)`); } catch { /* the page is gone */ }
        await client.close();
    }
    assert.deepEqual(problems, [], 'the Inbox and Settings by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS the Inbox and Settings say how they move, Star keeps the keyboard and says it, the Saved controls stay on Saved');
})().catch(e => { console.error(e); process.exit(1); });
