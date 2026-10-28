// Pages whose stylesheet moved out of the start's bundle (#10706): Docs, the Inbox's and Automations' view lists and the theme editor look as they did. It only takes shots (CORAL_SCREENSHOT_DIR) of each page at 1280 and 390 px,
// light and dark, so the same file can run on the tree before the move and the shots can be compared (its assertions, that the sheets are not in the start and arrive with their page, fail there, after the shots). Isolated dev server over CDP.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const problems = [];
(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); await sleep(600); /* sleep-ok: a shot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const sheets = () => ev(`[...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href.split('/').pop())`);
    const expect = async (what, name, want) => { const has = (await sheets()).includes(name); if (has !== want) problems.push(`${what}: ${name} ${want ? 'is not' : 'is'} linked`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1280, 900, false, 'dark'], [1280, 900, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light']]) {
            await Emulation.setEmulatedMedia({ features: mobile ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [] });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            const fresh = async (path = '/') => { await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); };
            await fresh('/docs'); await sleep(1500); /* sleep-ok: the docs list loads */ await ev(`Promise.resolve(window.selectDoc && window.selectDoc('quickstart')).then(() => true)`);
            await waitFor(`document.getElementById('docs-view').getClientRects().length > 0 && !!document.querySelector('#docs-view .docs-content') && document.querySelector('#docs-view .docs-content').textContent.length > 200`, 'the docs page', 15000);
            await expect(`docs ${w}/${theme}`, 'docs.css', true); await expect(`docs ${w}/${theme}`, 'content_table.css', true);
            await shot(`pages-${w}-${theme}-docs`);
            await fresh(); await expect(`start ${w}/${theme}`, 'docs.css', false); await expect(`start ${w}/${theme}`, 'view_list.css', false); await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.getElementById('inbox-local') && !document.getElementById('inbox-local').hidden`, 'the Inbox', 15000);
            await sleep(800); /* sleep-ok: the lists draw after their reads */
            await expect(`inbox ${w}/${theme}`, 'view_list.css', true);
            await shot(`pages-${w}-${theme}-inbox`);
            await fresh('/automations/jobs');
            await waitFor(`!!document.getElementById('group-table-view') && document.getElementById('group-table-view').textContent.length > 20`, 'Automations', 15000);
            await sleep(800); /* sleep-ok: the folders draw after their reads */
            await shot(`pages-${w}-${theme}-automations`);
            await fresh(); await ev(`window.showThemeConfigurator(); true`);
            await waitFor(`!!document.querySelector('.theme-configurator-content') && document.querySelector('.theme-configurator-content').getClientRects().length > 0`, 'the theme editor', 15000);
            await shot(`pages-${w}-${theme}-theme`);
        }
        assert.deepEqual(problems, [], problems.join(' | '));
        console.log('PASS lazy_styles_pages');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
