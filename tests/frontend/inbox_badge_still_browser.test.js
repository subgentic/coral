// The Inbox tab's count badge hangs on the tab and moves nothing (#8497, the operator: it shifted the top tabs when it appeared or went). With none waiting, then 3, then 120 ("9+"), every top tab keeps its left,
// right and width, the badge is out of the layout (absolute, at the word's top-right corner, 16 px high), the tab keeps its accessible name, and nothing scrolls sideways; at desktop and at the 768 px
// tab row. At 390 the row is a dropdown (no badge in it) and the page is as steady. A stand-in for the agents waiting (the live list); CORAL_SCREENSHOT_DIR saves the shots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const waiting = n => ev(`(async () => { const { state } = await import(${S} + 'state.js'), m = await import(${S} + 'inbox_tab.js');
        state.liveSessions = Array.from({ length: ${n} }, (_, i) => ({ name: 'w' + i, session_id: '0000000' + i + '-0000-4000-8000-0000000000aa', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Waiting ' + i, working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 300000).toISOString(), sleeping: false }));
        m.updateInboxTab(); return true; })()`);
    const tabs = () => ev(`[...document.querySelectorAll('.top-nav-tabs > .top-nav-tab:not(.nav-overflowed)')].filter(t => t.getClientRects().length).map(t => { const r = t.getBoundingClientRect(); return { id: t.id, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10, top: Math.round(r.top * 10) / 10 }; })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [768, 800, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waiting(0);
            const none = await tabs();
            if (mobile) {
                assert.equal(none.length, 0, at + 'no tab row on a phone');
            } else assert.ok(none.length >= 4, at + 'the tabs are there: ' + none.length);
            if (!mobile) { const sorted = [...none].sort((x, y) => x.left - y.left), gaps = sorted.slice(1).map((t, i) => Math.round(t.left - sorted[i].right)); assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, at + 'with nothing waiting every gap between the tabs is the same, the one after Inbox too (#9821): ' + JSON.stringify(gaps)); }
            for (const n of [3, 120]) {
                await waiting(n);
                await waitFor(`!document.getElementById('nav-tab-hub-inbox-badge').hidden`, at + 'the badge shows', 5000);
                assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`), n > 9 ? '9+' : String(n));
                assert.deepEqual(await tabs(), none, at + `every tab keeps its place with ${n} waiting`);
                if (!mobile) {
                    const b = await ev(`(() => { const t = document.getElementById('nav-tab-hub-inbox'), e = document.getElementById('nav-tab-hub-inbox-badge'), tr = t.getBoundingClientRect(), r = e.getBoundingClientRect(); return { pos: getComputedStyle(e).position, h: Math.round(r.height), dTop: Math.round(r.top - tr.top), dLeft: Math.round(r.left - tr.right), label: t.getAttribute('aria-label'), wide: document.documentElement.scrollWidth <= innerWidth }; })()`);
                    assert.equal(b.pos, 'absolute', at + 'the badge is out of the layout'); assert.equal(b.h, 16, at + 'a 16 px pill');
                    assert.ok(b.dTop >= 0 && b.dTop <= 4, at + 'at the tab\'s top: ' + JSON.stringify(b)); assert.ok(b.dLeft >= -16 && b.dLeft <= -10, at + 'hanging on the word\'s top-right corner (the tab\'s box has 12 px after the word: the pill starts about 2 px inside it, #9821): ' + JSON.stringify(b));
                    assert.equal(b.label, `Inbox, ${n} waiting for input`, at + 'the tab keeps its accessible name'); assert.ok(b.wide, at + 'no sideways scroll');
                }
                if (n === 3) await shot(`inbox-badge-${w}`);
            }
            if (!mobile) { // the badge ends before the next tab's word, with the biggest count ("9+"), at 100% and at 200% text (#9629)
                await waiting(120);
                for (const zoom of [1, 2]) {
                    await ev(`document.documentElement.style.fontSize = '${zoom * 16}px'; true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the text size settles the tabs
                    const g = await ev(`(() => { const t = document.getElementById('nav-tab-hub-inbox'), e = document.getElementById('nav-tab-hub-inbox-badge'); let next = t.nextElementSibling; while (next && (!next.classList.contains('top-nav-tab') || next.classList.contains('nav-overflowed') || !next.getClientRects().length)) next = next.nextElementSibling; if (!next) return null; const n = next.getBoundingClientRect(); return { badgeRight: Math.round(e.getBoundingClientRect().right), nextWord: Math.round(n.left + parseFloat(getComputedStyle(next).paddingLeft)), next: next.id, wide: document.documentElement.scrollWidth <= innerWidth }; })()`);
                    if (g) assert.ok(g.badgeRight <= g.nextWord && g.wide, at + `${zoom * 100}% text: the "9+" badge ends before the next tab's word: ` + JSON.stringify(g));
                }
                await ev(`document.documentElement.style.fontSize = ''; true`);
                { const until = Date.now() + 3000; while (Date.now() < until && JSON.stringify(await tabs()) !== JSON.stringify(none)) await new Promise(r => setTimeout(r, 100)); } // sleep-ok: the tab row measures itself again when the text size goes back; it is waited for until it is where it was
            }
            await waiting(0);
            assert.deepEqual(await tabs(), none, at + 'and the tabs are where they were when the badge goes');
            console.log(`   ✓ ${at}`);
        }
        console.log('PASS inbox badge: it hangs on the tab; no tab moves when it shows, changes or goes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
