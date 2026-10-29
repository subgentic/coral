// The Docs search finds a topic by words in any order, puts the topics whose TITLE has the words first, and shows what matched under each hit (#10093 v2, Desktop #10087): "add a member" used to find nothing unless the
// phrase was there word for word. Against the real docs of the isolated dev server, 1280 px.
//  - the words may come in any order ("member add" finds what "add member" finds);
//  - a topic whose title has the words comes first ("demos worked" puts Worked demos first);
//  - a hit that is in a topic's text, not its title, shows a snippet of that text with a word in it, a title hit shows the topic's summary as before.
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
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);
        const search = async q => { await ev(`(() => { const i = document.getElementById('docs-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await sleep(300); }; // sleep-ok: the topics' text is read once, then the list is drawn again
        const shown = () => ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].map(b => b.dataset.doc)`);
        const settled = async () => { await waitFor(`!/Searching the topics/.test(document.getElementById('docs-nav-list').textContent)`, 'the search settled', 20000); await sleep(300); }; // sleep-ok: the list is redrawn after the text arrives

        await search('add member'); await settled(); const a = await shown();
        await search('member add'); await settled(); const b = await shown();
        check('the words may come in any order: "member add" finds what "add member" finds', a.length > 0 && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()), JSON.stringify([a.length, b.length]));

        await search('demos worked'); await settled(); const t = await shown();
        check('a topic whose title has the words comes first ("demos worked" puts worked-demos first)', t[0] === 'worked-demos', JSON.stringify(t.slice(0, 4)));

        await search('permission sandbox'); await settled();
        const snips = await ev(`[...document.querySelectorAll('#docs-nav-list .doc-snippet')].map(e => e.textContent.trim())`);
        check('a topic found by its text shows a snippet with a word of the search in it', snips.length > 0 && snips.every(x => /permission|sandbox/i.test(x)) && snips.every(x => x.length <= 200), JSON.stringify(snips.slice(0, 3)));
        await shot('docs-search-snippets-1280');

        await search('troubleshooting'); await settled();
        const none = await ev(`[...document.querySelectorAll('#docs-nav-list [data-doc="troubleshooting"] .doc-snippet')].length`);
        check('a topic found by its title shows no snippet (its summary shows in the table)', none === 0);
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} docs search checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
