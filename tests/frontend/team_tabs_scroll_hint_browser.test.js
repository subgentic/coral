// A phone's team tab strip says it scrolls (walk 81 item 9, #17816): the strip holds all eight tabs and a 390 px screen shows four, so while more tabs wait past the edge a 44 px "Show more tabs" button sits at
// its end (the 32 px fade alone did not read as "there is more"); tapping it brings the next tabs into view, and it is gone once the last tab is shown. A desktop strip, which fits, has none.
// Real seeded team over the API, real tap. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-hint-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const state = () => ev(`(() => { const t = document.getElementById('team-tabs'), b = document.getElementById('team-tabs-next'), shown = !!b && getComputedStyle(b).display !== 'none' && getComputedStyle(b).visibility !== 'hidden' && b.getClientRects().length > 0 /* at the strip's end it keeps its room, hidden (#18984) */, r = b ? b.getBoundingClientRect() : null, tr = t.getBoundingClientRect();
        return { more: t.getAttribute('data-more'), rawLeft: t.scrollLeft, clientWidth: t.clientWidth, scrollWidth: t.scrollWidth, visibility: b && getComputedStyle(b).visibility, scrolls: t.scrollWidth > t.clientWidth + 1, left: Math.round(t.scrollLeft), max: t.scrollWidth - t.clientWidth, shown, name: b ? b.getAttribute('aria-label') : null, w: r && Math.round(r.width), h: r && Math.round(r.height), atEnd: !!r && Math.abs(r.left - tr.right) <= 1,
            last: (() => { const e = document.getElementById('team-tab-branches').getBoundingClientRect(); return e.right <= tr.right + 1; })() }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // Reproduce the Windows gate's end-position/stale-cue snapshot deterministically:
        // the scroll position changes before its scroll listeners update data-more.
        const eventDelay = Number(process.env.CORAL_TEST_SCROLL_EVENT_DELAY_MS || 0);
        if (eventDelay) await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const add = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function(type, listener, options) {
                if (type === 'scroll' && this.id === 'team-tabs' && typeof listener === 'function') {
                    const target = this, original = listener;
                    listener = event => setTimeout(() => original.call(target, event), ${eventDelay});
                }
                return add.call(this, type, listener, options);
            };
        })()` });
        for (const [w, mobile] of [[390, true], [820, true], [1440, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM); await settle(800);
            let s = await state();
            if (!mobile) { assert.equal(s.scrolls, false, 'a desktop strip fits'); assert.equal(s.shown, false, 'and has no scroll button: ' + JSON.stringify(s)); continue; }
            if (w === 820) { // a tablet strip (#17696, walk 80 #13): wider tabs (a larger text size) overflow it, and it says so like a phone's
                await ev(`(() => { const st = document.createElement('style'); st.textContent = '#team-tabs .tab { min-width: 130px; }'; document.head.append(st); return true; })()`); await settle(800); s = await state();
                assert.ok(s.scrolls && s.shown && s.name === 'Show more tabs', 'at 820 px an overflowing strip has the "Show more tabs" button: ' + JSON.stringify(s));
                continue;
            }
            assert.equal(s.scrolls, true, 'a phone strip scrolls: ' + JSON.stringify(s));
            assert.ok(s.shown && s.name === 'Show more tabs' && s.w >= 44 && s.h >= 44 && s.atEnd, 'a 44 px "Show more tabs" button sits beside the strip\'s end (right of it, over no tab: #18867) while tabs wait past the edge: ' + JSON.stringify(s));
            await ev(`document.getElementById('team-tabs-next').click(); true`);
            // > 0, not > 100: with narrower fonts (Ubuntu CI) the tabs overflow by little, and the button hides at the end, which widens the strip and lowers its largest scroll (#18963)
            await waitFor(`document.getElementById('team-tabs').scrollLeft > 0`, 'the strip scrolled to the next tabs', 5000).catch(async e => { throw new Error(e.message + ': ' + JSON.stringify(await state())); });
            for (let i = 0; i < 4 && (await state()).shown; i++) { await ev(`document.getElementById('team-tabs-next').click(); true`); await settle(500); }
            // Geometry can reach the end before the scroll event updates data-more (Windows #19074).
            // Wait for the observable result; a cue that stays shown still fails, with its raw state.
            await waitFor(`(() => {
                const tabs = document.getElementById('team-tabs'), next = document.getElementById('team-tabs-next');
                const last = document.getElementById('team-tab-branches').getBoundingClientRect().right <= tabs.getBoundingClientRect().right + 1;
                return last && (!next || !next.getClientRects().length || getComputedStyle(next).display === 'none' || getComputedStyle(next).visibility === 'hidden');
            })()`, 'the last tab is visible and the scroll cue is hidden', 5000).catch(async e => { throw new Error(e.message + ': ' + JSON.stringify(await state())); });
            s = await state();
            assert.ok(s.last && !s.shown, 'at the last tab (Branches) the button is gone: ' + JSON.stringify(s));
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    console.log('PASS the phone team tab strip says it scrolls');
})().catch(e => { console.error(e.message); process.exit(1); });
