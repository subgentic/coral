// The inline "Learn more" buttons of Settings draw an invisible 44 px hit area (an ::after on the button, #7663, #8079); it must never take a click meant for the control next to it (#8107, UI/UX on #8079).
// For each visible inline Learn more (and the Terminal card's, and "Show less" once opened) of every Settings group and of the team page's Settings tab, at 1280 px, 390 px and 200% text: a hit test at the middle
// and the four corners of every other control on the screen must return that control, never the Learn more. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const probe = () => ev(`(() => {
        const learns = [...document.querySelectorAll('.sv-learn')].filter(b => b.getClientRects().length);
        const bad = []; let considered = 0, takenByOwn = 0;
        for (const b of learns) {
            const root = b.closest('#settings-modal') || b.closest('#team-panel-settings') || document; // what is behind a dialog is not the hit area's neighbour
            const others = [...root.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=switch]')].filter(e => e.getClientRects().length);
            const r = b.getBoundingClientRect();
            for (const o of others) {
                if (o === b || b.contains(o) || o.contains(b)) continue;
                const q = o.getBoundingClientRect();
                for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) { // the middle and the four corners of the control: any part of it that the hit area takes is a click lost
                    const x = q.left + q.width * fx, y = q.top + q.height * fy;
                    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue; // only what is on the screen can be hit
                    considered++;
                    const hit = document.elementFromPoint(x, y);
                    if (hit && hit !== o && !o.contains(hit) && (hit === b || b.contains(hit))) { bad.push((b.getAttribute('aria-label') || b.textContent).slice(0, 40) + ' takes a click meant for ' + ((o.getAttribute('aria-label') || o.textContent || o.id || o.tagName).trim().slice(0, 40)) + ' at ' + fx + ',' + fy); break; }
                }
            }
        }
        return { learns: learns.length, bad, considered };
    })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const out = []; let considered = 0;
        for (const [label, w, h, mobile, zoom] of [['1280', 1280, 1000, false, ''], ['1280-200', 1280, 1000, false, '200%'], ['390', 390, 844, true, ''], ['390-200', 390, 844, true, '200%']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__coral.buildAllLazy(); window.showSettingsModal(); true`);
            await waitFor(`!!document.getElementById('settings-tab-network')`, 'the Settings dialog', { timeout: 8000 });
            if (zoom) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
            const tabs = await ev(`[...document.querySelectorAll('#settings-tabs [role=tab]')].map(b => b.id)`);
            let seen = 0;
            for (const id of tabs) {
                await ev(`document.getElementById(${JSON.stringify(id)}).click(); true`); await settle(300);
                // every Learn more opened too: its words are longer lines, with the Show less in them
                await ev(`document.querySelectorAll('.sv-learn').forEach(b => { if (b.getClientRects().length && b.getAttribute('aria-expanded') === 'false') b.click(); }); true`); await settle(200);
                const p = await probe(); seen += p.learns; considered += p.considered;
                for (const m of p.bad) out.push(`${label} ${id}: ${m}`);
            }
            assert.ok(seen > 0, `${label}: some Learn more buttons were seen`);
        }
        // the team page's Settings tab: the same Learn more buttons beside its own links (Messaging, the working mode's "Settings" link) at the same widths
        const B = 'learn-8107-' + (Date.now() % 100000);
        await ev(`fetch('/api/board/${B}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'orchestrator', job_title: 'Orchestrator', session_name: 'o-s' }) }).then(r => r.status)`);
        await ev(`fetch('/api/board/${B}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'orchestrator', content: 'hello' }) }).then(r => r.status)`);
        try {
            for (const [label, w, h, mobile, zoom] of [['team 1280', 1280, 1000, false, ''], ['team 1280-200', 1280, 1000, false, '200%'], ['team 390-200', 390, 844, true, '200%']]) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: `${process.env.CORAL_TEST_URL}/team/${B}/settings` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
                await waitFor(`document.querySelectorAll('#team-panel-settings .sv-learn').length > 0`, 'the team settings Learn more buttons', { timeout: 15000 });
                if (zoom) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`); await settle(500);
                const p = await probe();
                assert.ok(p.learns > 0, `${label}: Learn more buttons were seen`);
                for (const m of p.bad) out.push(`${label}: ${m}`);
            }
        } finally { await ev(`fetch('/api/board/${B}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {}); }
        if (process.env.WALK_LOG) require('node:fs').appendFileSync(process.env.WALK_LOG, 'points of other controls tested: ' + considered + '\n');
        assert.deepEqual(out, [], 'a Learn more hit area covers a neighbouring control:\n  ' + out.join('\n  '));
        console.log('PASS the inline Learn more hit area covers no neighbouring control');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
