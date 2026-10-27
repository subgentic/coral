// The + New chooser's type cards say what they open (#9253, the operator: bring back the descriptions that #6012 took out).
// Four cards at 1280 and 390, each with its one-line description: New agent, New team, Terminal and Open folder (the full line, "Pin a folder to your Agents list, ready to launch into"); no description is cut by its card, the four cards of a row are one height, and nothing is wider than the screen.
// Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const WORDS = {
    'New agent': 'Launch Claude, Antigravity, or Codex with system prompt and tools',
    'New team': 'Launch multiple agents collaborating on a shared message board',
    'Terminal': 'Open a shell session you can use alongside your agents',
    'Open folder': 'Pin a folder to your Agents list, ready to launch into',
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`window.showLaunchModal(); true`);
            await waitFor(`!!document.getElementById('launch-modal') && getComputedStyle(document.getElementById('launch-modal')).display !== 'none' && document.querySelectorAll('#launch-step-chooser .launch-type-card').length >= 4`, 'the chooser', 10000);
            const cards = await ev(`[...document.querySelectorAll('#launch-step-chooser .launch-type-card')].filter(c => c.getClientRects().length).map(c => { const r = c.getBoundingClientRect(), d = c.querySelector('.launch-type-desc'), dr = d && d.getBoundingClientRect();
                return { label: c.querySelector('.launch-type-label').textContent.trim(), desc: d ? d.textContent.trim() : '', h: Math.round(r.height), top: Math.round(r.top), inside: !!dr && dr.bottom <= r.bottom + 1 && dr.top >= r.top - 1 && dr.left >= r.left - 1 && dr.right <= r.right + 1, over: Math.round(c.scrollWidth - c.clientWidth) }; })`);
            check(`${label}: four type cards`, cards.length === 4, cards.map(c => c.label).join(', '));
            for (const c of cards) check(`${label}: ${c.label} has its description`, WORDS[c.label] === c.desc, JSON.stringify(c.desc));
            check(`${label}: every description is inside its card (not cut)`, cards.every(c => c.inside && c.over <= 0), JSON.stringify(cards.map(c => [c.label, c.inside, c.over])));
            const rows = new Map(); for (const c of cards) rows.set(c.top, [...(rows.get(c.top) || []), c.h]);
            check(`${label}: the cards of a row are one height`, [...rows.values()].every(hs => Math.max(...hs) - Math.min(...hs) <= 2), JSON.stringify([...rows.entries()]));
            check(`${label}: nothing is wider than the screen`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            if (process.env.CORAL_SCREENSHOT_DIR) require('fs').writeFileSync(process.env.CORAL_SCREENSHOT_DIR + '/launch-chooser-' + label + '.png', Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} chooser checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
