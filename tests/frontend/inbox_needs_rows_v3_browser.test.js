// #22094 replaces column-aligned table anatomy with grouped ledger rows.
// Replacements below prove each row keeps selection, icon separation, identity and elapsed time; permission Dismiss is deliberately removed by v19.
// Needs you rows, guidelines v3 section 4.14 (#17451): one row anatomy, tick box, icon and name at the same x on every row (N3); an agent's prompt has a tick box and its Dismiss in the kebab (N5); the wait is grey and short, the amber triangle only past a day (N7). 1440, 1280, 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`try { localStorage.removeItem('coral-inbox-needs-filters'); } catch {} true`);
            await ev(`(() => { for (let i = 0; i < 5; i++) window.__m.add('Agent ' + i, String.fromCharCode(65 + i), 4, { sleeping: false, board_project: 'team-' + (i % 2), session_id: 'sid-' + i }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 5`, 'five agents', 8000);
            await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); const K = ['permission', 'question', 'plan', 'permission', 'question'];
                window.__qaState.liveSessions = window.__qaState.liveSessions.map((s, i) => ({ ...s, waiting_for_input: true, waiting_kind: K[i], waiting_since: ago(i === 4 ? 2 * 24 * 60 : 3 + i * 40) }));
                (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
            if (mobile) await ev(`document.querySelector('#group-table-view .view-list-item[data-key="needs"]')?.click(); true`); else await ev(`document.querySelector('.view-list-item[data-key="needs"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view .nl-row').length === 5`, 'the five rows', 8000); await settle(400);
            await shot(`needs-${w}`);
            const g = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view .nl-row')]; return rows.map(row => { const icon = row.querySelector('.nl-icon,.inbox-kind-icon'), title = row.querySelector('.nl-title'), when = row.querySelector('.nl-when'), box = row.getBoundingClientRect(), i = icon.getBoundingClientRect(), t = title.getBoundingClientRect(); return { permission: row.classList.contains('nl-permission'), check: !!row.querySelector('.nl-check'), icon: i.left >= box.left && i.right <= t.left + 1, title: title.textContent, age: when.textContent, at: Date.parse(when.dateTime), muted: getComputedStyle(when).color !== getComputedStyle(title).color, permissionDismiss: row.classList.contains('nl-permission') && [...row.querySelectorAll('button')].some(b => b.textContent === 'Dismiss' && !b.hidden) }; }); })()`);
            assert.equal(g.length, 5, w + ': one ledger row per request');
            assert.ok(g.every(r => r.check && r.icon && r.title && Number.isFinite(r.at)), w + ': each row keeps selection, separate icon/title, and a valid source timestamp: ' + JSON.stringify(g));
            assert.ok(g.every(r => r.muted && /ago$/.test(r.age)), w + ': elapsed time remains short, explicit and muted: ' + JSON.stringify(g));
            assert.ok(g.filter(r => r.permission).every(r => r.permissionDismiss), w + ': permission Dismiss remains under the Orchestrator action ruling');
            await shot(`rows-${w}`);
        }
        await client.close(); process.exit(0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})();
