// The Docs tab starts with the answers a newcomer needs (#10093 v2, Desktop #10087): "How do I...?" is the first topic of Getting started, then Quickstart; the API reference and every API page sit under a group called
// "For developers", not in Getting started; Getting started has the newcomer pages only. Against the real docs of the isolated dev server, 1280 px.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);
        const groups = await ev(`(() => { const out = []; let cur = null; for (const li of document.querySelectorAll('#docs-nav-list > li')) { const h = li.querySelector('.group-header-label, .group-title, h3, [data-group]'); const btn = li.querySelector('[data-doc]'); if (btn) { if (cur) cur.docs.push(btn.dataset.doc); } else { cur = { label: li.textContent.replace(/\\s+/g, ' ').trim(), docs: [] }; out.push(cur); } } return out; })()`);
        const gs = groups.find(g => /^Getting started/.test(g.label)), dev = groups.find(g => /^For developers/.test(g.label));
        check('the groups are Getting started and For developers', !!gs && !!dev && !groups.some(g => /^API\b/.test(g.label)), JSON.stringify(groups.map(g => g.label)));
        check('How do I... is the first topic of Getting started, then Quickstart', gs && gs.docs[0] === 'how-do-i' && gs.docs[1] === 'quickstart', JSON.stringify(gs && gs.docs));
        check('its title keeps the pronoun a capital: "How do I...?"', (await ev(`(document.querySelector('#docs-nav-list [data-doc="how-do-i"]') || {}).textContent`)) === 'How do I...?', String(await ev(`(document.querySelector('#docs-nav-list [data-doc="how-do-i"]') || {}).textContent`)));
        check('Getting started has the newcomer pages only: no API reference, no Sessions API', gs && !gs.docs.includes('README') && !gs.docs.includes('sessions') && gs.docs.every(d => ['how-do-i', 'quickstart', 'using-the-dashboard', 'worked-demos', 'workflow-quickstart', 'troubleshooting'].includes(d)), JSON.stringify(gs && gs.docs));
        check('the API reference and the API pages are under For developers', dev && dev.docs.includes('README') && dev.docs.includes('sessions'), JSON.stringify(dev && dev.docs.slice(0, 6)));
        await shot('docs-groups-1280');
        await ev(`document.querySelector('#docs-nav-list [data-doc="how-do-i"]').click(); true`);
        await waitFor(`/Add a team member/.test(document.getElementById('docs-content').textContent) && /Mobile QR code/.test(document.getElementById('docs-content').textContent)`, 'the topic', 8000);
        const heads = await ev(`[...document.querySelectorAll('#docs-content h2')].map(h => h.textContent.trim())`);
        check('How do I... answers the four first questions with click steps', ['Add a team member', 'Change the default model', 'Open Coral on your phone'].every(h => heads.includes(h)) && heads.some(h => /sleep/i.test(h)), JSON.stringify(heads));
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} docs group checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
