// A returning person's dashboard reopens where they were (#10057, Beta Tester #10044): after a restart (or a closed tab) the page at "/" shows the last team, agent or chat they had open, not Home.
// Only the bare start is restored: a link (/inbox, /analytics, a team address) is shown as written, Home chosen on purpose stays Home on the next start, a place that is gone falls back to Home without
// a "not found" message, and a phone keeps Home (its Agents list). The place is kept in this browser (localStorage coral-last-place) as the address of the route. 1280 and 390 px. Isolated dev server over CDP.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { seed } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-restore-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const open = async path => { await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await sleep(900); }; // sleep-ok: the start route is shown after the live list answers; no single completion event
    const state = () => ev(`({ path: location.pathname, search: location.search, kept: (() => { try { return localStorage.getItem('coral-last-place'); } catch { return 'blocked'; } })(), toast: [...document.querySelectorAll('.toast, #toast-container .toast, [role=alert]')].map(t => t.textContent.trim()).filter(Boolean), home: !!document.getElementById('welcome-screen') && getComputedStyle(document.getElementById('welcome-screen')).display !== 'none' && document.getElementById('welcome-screen').getBoundingClientRect().height > 0, team: !!document.getElementById('team-page-view') && getComputedStyle(document.getElementById('team-page-view')).display !== 'none' && document.getElementById('team-page-view').getBoundingClientRect().height > 0 })`);
    const isHome = p => p === '/' || p === '/agents'; // Home's address is /agents once the start is written
    const go = route => ev(`Promise.all([import(${S} + 'nav.js'), import(${S} + 'routes.js')]).then(([n, r]) => n.go(${route})).then(() => true)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await open('/'); await seed(ev, TEAM); await ev(`try { localStorage.removeItem('coral-last-place'); } catch {} true`);
            await open('/');
            let v = await state();
            check(`${tag}: a first start at "/" is Home`, isHome(v.path) && v.kept === null, JSON.stringify(v));

            // a team opened by the person is remembered, and the next bare start shows it
            await go(`{ view: 'team', id: ${JSON.stringify(TEAM)} }`); await sleep(700); // sleep-ok: the team page draws over several reads
            v = await state();
            check(`${tag}: opening a team keeps it as the last place`, v.path === ('/team/' + TEAM) && v.kept === ('/team/' + TEAM), JSON.stringify(v));
            await open('/');
            v = await state();
            if (mobile) { check(`${tag}: a phone keeps Home at "/" (its Agents list), and keeps the place for a wide screen`, isHome(v.path) && v.kept === ('/team/' + TEAM), JSON.stringify(v)); await shot(`restore-last-place-${w}`); }
            else {
                check(`${tag}: the next start at "/" reopens that team, not Home`, v.path === ('/team/' + TEAM) && v.team && !v.home, JSON.stringify(v));
                await shot(`restore-last-place-${w}`);
                // a real click on the Inbox tab right after a restored start opens the Inbox (#10151: the restore must never hold the person on the Agents tab)
                const at = await ev(`(() => { const b = document.getElementById('nav-tab-hub-inbox').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
                await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
                await sleep(1200); // sleep-ok: the Inbox draws after the click
                v = await ev(`({ tab: document.body.getAttribute('data-nav-tab'), path: location.pathname, inbox: !!document.getElementById('group-table-view') && document.getElementById('group-table-view').getClientRects().length > 0 })`);
                check(`${tag}: a real click on the Inbox tab after a restored start opens the Inbox`, v.tab === 'hub-inbox' && v.inbox && /^\/inbox/.test(v.path), JSON.stringify(v));
            }

            // a link is shown as written
            await open('/analytics');
            v = await state();
            check(`${tag}: a link (/analytics) is shown as written, not replaced by the last place`, v.path === '/analytics' && !v.team, JSON.stringify(v));

            // a place that is gone: Home, quietly, and forgotten
            if (!mobile) {
                await ev(`localStorage.setItem('coral-last-place', '/team/qa-restore-gone-team'); true`);
                await open('/');
                v = await state();
                check(`${tag}: a remembered team that was deleted opens Home, not a "No team named" page, and is forgotten`, isHome(v.path) && !v.team && v.kept === null, JSON.stringify(v));
            }
            await ev(`localStorage.setItem('coral-last-place', '/agents/00000000-0000-4000-8000-000000000000'); true`);
            await open('/');
            v = await state();
            check(`${tag}: a remembered agent that is gone opens Home with no "not found" message, and is forgotten`, isHome(v.path) && !v.toast.some(t => /not (found|running)/i.test(t)) && (mobile || v.kept === null), JSON.stringify(v)); // a phone does not try the place, so it keeps it for a wide screen

            // Home chosen on purpose stays Home
            if (!mobile) {
                await go(`{ view: 'team', id: ${JSON.stringify(TEAM)} }`); await sleep(500); // sleep-ok: the team page draws
                await go(`{ view: 'agents' }`); await sleep(500); // sleep-ok: Home is shown after the team page leaves
                v = await state();
                check(`${tag}: Home chosen on purpose forgets the place`, isHome(v.path) && v.kept === null, JSON.stringify(v));
                await open('/');
                v = await state();
                check(`${tag}: and the next start is Home`, isHome(v.path) && v.home, JSON.stringify(v));
            }
            await ev(`try { localStorage.removeItem('coral-last-place'); } catch {} true`);
        }
    } finally { try { await removeBoards(ev, [TEAM]); } catch {} await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} restore checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
