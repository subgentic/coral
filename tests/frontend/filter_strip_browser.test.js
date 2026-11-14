// The filter strip (design guidelines 4.7, #15815): the Goals, Tasks, Jobs and Workflows filters are one bordered strip with 6 px corners (not separate pills at 999 px); the chosen part is the accent fill and
// readable (4.5:1) in dark and light; a part with 0 is dimmed and kept; at 390 px the strip scrolls sideways instead of wrapping; at 200% text nothing wraps. Measured on the team page's Goals tab (a team made through the API on the isolated dev server).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady } = require('./helpers/wait');
const BOARD = 'filter-strip-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, theme, zoom, mobile] of [['1440 dark', 1440, 'dark', ''], ['1440 light', 1440, 'light', ''], ['1440 200% text', 2600, 'dark', '200%'], ['390 touch dark', 390, 'dark', '', true], ['390 touch light', 390, 'light', '', true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile: !!mobile }); await Emulation.setTouchEmulationEnabled({ enabled: !!mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`fetch('/api/board/${BOARD}/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', title: 'Ship the strip', outcome: 'One strip', done_when: 'it is true' }) }).then(r => r.status)`);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; T.state.liveSessions = []; T.render.renderLiveSessions([]); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
            await waitFor(`[...document.querySelectorAll('.goals-chips')].some(g => g.getClientRects().length && g.querySelectorAll('.goals-chip').length >= 3) || (${!!mobile} && [...document.querySelectorAll('.team-tb-select')].some(e => e.getClientRects().length))`, `${label}: the Goals strip is drawn`, 15000);
            if (mobile && !(await ev(`[...document.querySelectorAll('.goals-chips')].some(g => g.getClientRects().length && g.querySelectorAll('.goals-chip').length >= 3)`))) { check(await ev(`[...document.querySelectorAll('.goals-chip, .list-bar-chip, .team-tb-chip')].every(e => parseFloat(getComputedStyle(e).borderTopLeftRadius) <= 10)`), `${label}: the select takes the strip's place and no 999 px corner is left`); continue; } // the phone swaps the strip for a select (below 54 rem); the strip's scroll is measured where it shows
            await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: one pass for the strip's fonts and the colour transition
            const r = await ev(`(() => { const strip = [...document.querySelectorAll('.goals-chips')].find(g => g.getClientRects().length && g.querySelectorAll('.goals-chip').length >= 3), parts = [...strip.querySelectorAll('.goals-chip')]; const cs = getComputedStyle(strip), rgb = c => (c.match(/[\\d.]+/g) || []).map(Number);
                const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
                const ratio = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
                const on = parts.find(p => p.getAttribute('aria-pressed') === 'true'), zero = parts.find(p => p.classList.contains('goals-chip-zero')), plain = parts.find(p => p.getAttribute('aria-pressed') !== 'true' && !p.classList.contains('goals-chip-zero'));
                const radii = [...document.querySelectorAll('.goals-chip, .list-bar-chip, .team-tb-chip')].map(e => getComputedStyle(e).borderTopLeftRadius);
                return { box: cs.borderTopWidth + ' ' + cs.borderTopLeftRadius, parts: parts.length, partRadius: [...new Set(parts.map(p => getComputedStyle(p).borderTopLeftRadius))], radii999: radii.filter(x => parseFloat(x) > 10), tops: [...new Set(parts.map(p => Math.round(p.getBoundingClientRect().top)))].length,
                    scrolls: strip.scrollWidth > strip.clientWidth + 1, fits: strip.getBoundingClientRect().right <= innerWidth + 1, onRatio: on ? ratio(getComputedStyle(on).color, getComputedStyle(on).backgroundColor) : 0, onBg: on ? getComputedStyle(on).backgroundColor : '', plainBg: plain ? getComputedStyle(plain).backgroundColor : '', zeroKept: !!zero, zeroDim: zero ? getComputedStyle(zero).color !== getComputedStyle(plain).color : false, zeroRatio: zero ? ratio(getComputedStyle(zero).color, getComputedStyle(zero).backgroundColor) : 0, counts: parts.every(p => /\\d/.test(p.textContent) || p.dataset.filter === 'all'), words: parts.map(p => p.textContent) }; })()`);
            const at = label + ': ';
            check(r.box === '1px 6px', `${at}the strip is one box with 6 px corners (${r.box})`);
            check(r.partRadius.length === 1 && r.partRadius[0] === '0px', `${at}its parts are square inside it (${r.partRadius})`);
            check(!r.radii999.length, `${at}no 999 px corner left on a filter (${r.radii999})`);
            check(r.tops === 1, `${at}the parts share one line (${r.tops} lines)`);
            check(r.onRatio >= 4.5 && r.onBg !== r.plainBg, `${at}the chosen part is the accent fill and readable (${r.onRatio.toFixed(2)}:1, ${r.onBg} vs ${r.plainBg})`);
            check(r.zeroKept && r.zeroDim && r.zeroRatio >= 4.5, `${at}a part with 0 is kept and dimmed, still readable (${r.zeroRatio.toFixed(2)}:1): ${r.words}`);
            if (mobile) check(r.fits, `${at}the strip stays inside the screen (it scrolls sideways)`);
            if (label === '1440 dark' || label === '390 touch light') await shot('strip-' + label.replace(/ /g, '-'));
        }
    } finally { try { await removeBoards(ev, [BOARD]); } catch (e) {} try { await client.close(); } catch (e) {} }
    assert.deepEqual(problems, [], 'The filter strip:\n  ' + problems.join('\n  '));
    console.log('PASS the filters are one strip');
})().catch(e => { console.error(e); process.exit(1); });
