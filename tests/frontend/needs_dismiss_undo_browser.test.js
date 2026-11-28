// Dismiss on a Needs you row says so and can be undone (#17410, walk 68 step 3): the button on a welcome item gives a toast with Undo (30 s), the settings it saves name the item (inbox_welcome_dismissed, which the
// server's Activity row names it from), Undo puts it back, and Settings > Inbox lists what was dismissed with Restore. At 1280 and 390 px, through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__puts = []; window.__realFetch = window.__realFetch || window.fetch; window.fetch = (u, o) => { const s = String(u), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (s.includes('/api/board/projects')) return json([]);
                if (s.includes('/api/settings') && o && o.method === 'PUT') { window.__puts.push(JSON.parse(o.body)); return json({ ok: true }); }
                return window.__realFetch(u, o); };
                T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '', inbox_welcome_dismissed: '' }; T.state.liveSessions = []; T.state.servers = []; true`);
            const open = () => ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            const names = () => ev(`document.querySelectorAll('#group-table-view .nl-row[data-needs-key*="welcome:"]').length`);
            const toast = () => ev(`(() => { const t = [...document.querySelectorAll('.toast')].find(x => /Dismissed:/.test(x.textContent)); return t ? { text: t.textContent.replace(/\\s+/g, ' ').trim(), undo: !!t.querySelector('button') } : null; })()`);
            await open();
            await waitFor(`document.querySelectorAll('#group-table-view .nl-row[data-needs-key*="welcome:"]').length === 5`, `${tag}: five welcome items`, 8000);
            // Dismiss on the second item (Start your first agent)
            await ev(`[...document.querySelectorAll('#group-table-view button')].find(b => b.getAttribute('aria-label') === 'Dismiss: Start your first agent' || (b.textContent === 'Dismiss' && b.closest('.nl-row') && /Start your first agent/.test(b.closest('.nl-row').textContent))).click(); true`);
            await waitFor(`!/Start your first agent/.test(document.getElementById('group-table-view').textContent)`, `${tag}: Dismiss puts the item away`, 6000);
            await waitFor(`[...document.querySelectorAll('.toast')].some(x => /Dismissed:/.test(x.textContent))`, `${tag}: a toast says it was dismissed`, 4000);
            const t = await toast();
            check(t && /Dismissed: Start your first agent/.test(t.text) && t.undo, `${tag}: the toast names the item and has Undo: ` + JSON.stringify(t));
            check(await ev(`window.__puts.some(p => p.inbox_welcome_dismissed === 'agent' && /agent/.test(p.inbox_welcome_done))`), `${tag}: the one save names the dismissed item: ` + JSON.stringify(await ev(`window.__puts`)));
            await shot(`dismiss-toast-${w}`);
            // Undo
            await ev(`[...document.querySelectorAll('.toast')].find(x => /Dismissed:/.test(x.textContent)).querySelector('button').click(); true`);
            await waitFor(`/Start your first agent/.test(document.getElementById('group-table-view').textContent)`, `${tag}: Undo puts the item back`, 6000);
            check(await names() === 5, `${tag}: five items again`);
            check(await ev(`window.__puts.some(p => p.inbox_welcome_dismissed === '' && p.inbox_welcome === 'on')`), `${tag}: Undo takes it off the dismissed list`);
            // Dismiss again, then Settings > Inbox lists it with Restore
            await ev(`document.querySelectorAll('.toast').forEach(x => x.remove()); [...document.querySelectorAll('#group-table-view button')].find(b => b.getAttribute('aria-label') === 'Dismiss: Start your first agent' || (b.textContent === 'Dismiss' && b.closest('.nl-row') && /Start your first agent/.test(b.closest('.nl-row').textContent))).click(); true`);
            await waitFor(`!/Start your first agent/.test(document.getElementById('group-table-view').textContent)`, `${tag}: dismissed again`, 6000);
            await ev(`(async () => { await window.showSettingsModal(); await import(${S} + 'settings_nav.js').then(m => m.openSettingsGroup('needs-you')); await import(${S} + 'settings_inbox.js').then(m => m.drawDismissed()); return true; })()`);
            await waitFor(`!!document.getElementById('settings-inbox-dismissed') && !document.getElementById('settings-inbox-dismissed').hidden`, `${tag}: Settings > Inbox lists the dismissed items`, 5000);
            const list = await ev(`document.getElementById('settings-inbox-dismissed').textContent.replace(/\\s+/g, ' ').trim()`);
            check(/Dismissed from Needs you/.test(list) && /Start your first agent/.test(list), `${tag}: the list names the item: ${list}`);
            await ev(`document.getElementById('settings-inbox-dismissed').scrollIntoView({ block: 'center' }); true`);
            await shot(`dismissed-list-${w}`);
            await ev(`document.querySelector('#settings-inbox-dismissed button').click(); true`);
            await waitFor(`document.getElementById('settings-inbox-dismissed').hidden`, `${tag}: Restore empties the list`, 5000);
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
            await open();
            await waitFor(`/Start your first agent/.test(document.getElementById('group-table-view').textContent)`, `${tag}: Restore puts the item back in Needs you`, 6000);
            await ev(`window.fetch = window.__realFetch; true`);
        }
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS Dismiss says so, offers Undo, and the dismissed items can be restored');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
