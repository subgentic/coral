// Docs search ranking (#17423): searching 'review' ranks user pages (Using the dashboard, How do I) above developer pages, and no snippet shows a task number like #1332.
// The Getting started group comes first and its first hit is a user page. Against the real docs of the isolated dev server, 1280 px.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.setItem('coral-sidebar-groups-docs', '[]'); true`);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);
        const search = async q => { await ev(`(() => { const i = document.getElementById('docs-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await sleep(300); }; // sleep-ok: wait for the list to redraw
        const settled = async () => { await waitFor(`!/Searching the topics/.test(document.getElementById('docs-nav-list').textContent)`, 'the search settled', 20000); await sleep(300); }; // sleep-ok: the list redraws after text arrives

        await search('review'); await settled();

        // The first group with hits should be Getting started
        const firstGroup = await ev(`(() => { for (const li of document.querySelectorAll('#docs-nav-list > li')) { const h = li.querySelector('.group-header-label, .group-title, h3, [data-group]'); if (h) return li.textContent.replace(/\\s+/g, ' ').trim(); } return ''; })()`);
        check('the first group for "review" is Getting started', /^Getting started/.test(firstGroup), firstGroup);

        // The first hit should be a Getting started user page
        const firstHit = await ev(`(document.querySelector('#docs-nav-list [data-doc]') || {}).dataset.doc`);
        const USER_PAGES = ['how-do-i', 'quickstart', 'key-concepts', 'using-the-dashboard', 'worked-demos', 'workflow-quickstart', 'troubleshooting'];
        check('the first hit is a Getting started page', USER_PAGES.includes(firstHit), firstHit);

        // No snippet should contain a task number like #1332
        const snippets = await ev(`[...document.querySelectorAll('#docs-nav-list .doc-snippet')].map(e => e.textContent)`);
        const taskNumRe = /#\d{3,}/;
        const bad = snippets.filter(s => taskNumRe.test(s));
        check('no snippet shows a task number', bad.length === 0, bad.length ? 'found: ' + JSON.stringify(bad.slice(0, 3)) : snippets.length + ' snippets clean');
        await shot('docs-search-rank-review-1280');
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} docs search rank checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
