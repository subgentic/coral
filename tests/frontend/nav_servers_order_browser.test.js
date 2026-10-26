// The Servers tab sits right of Analytics (the operator's order, #8704): on a hub with a registered computer the top row is Agents, Inbox, Workflows, Jobs, Analytics, Servers, Docs; the keyboard
// walks the tabs in that order, and a phone's view list (the dropdown) has the same order. One place defines it: the tab buttons' order in the page (nav_tabs.js draws the rest from them).
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server, with a fake hub (state.hub, one remote). 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const WANT = ['Agents', 'Inbox', 'Workflows', 'Jobs', 'Analytics', 'Servers', 'Docs'];
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const key = async (k, code) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'r1', label: 'Remote', status: 'online', version: '1.4.5', agents: 3 }];
                (await import((window.__coralStatic || '/static/') + 'servers_tab.js')).updateServersTabVisibility(); return true; })()`);
            await waitFor(`!document.getElementById('nav-tab-servers').hidden`, 'the Servers tab', 8000); await settle(400);
            // the tab buttons in the page's own order (the row; a phone hides the row for its dropdown but keeps the buttons)
            const dom = await ev(`[...document.querySelectorAll('.top-nav-tabs > .top-nav-tab[data-arg]')].filter(el => !el.hidden && !el.hasAttribute('data-cloud-only')).map(el => el.textContent.trim().replace(/\\d+$/, '').trim())`);
            check(`${label}: the tabs are Agents, Inbox, Workflows, Jobs, Analytics, Servers, Docs`, JSON.stringify(dom) === JSON.stringify(WANT), JSON.stringify(dom));
            if (!mobile) {
                const shown = await ev(`[...document.querySelectorAll('.top-nav-tabs > .top-nav-tab[data-arg]')].filter(el => el.getClientRects().length).map(el => el.textContent.trim().replace(/\\d+$/, '').trim())`);
                check('1280: the row draws them in that order', JSON.stringify(shown.filter(t => WANT.includes(t))) === JSON.stringify(WANT), JSON.stringify(shown));
                await ev(`document.getElementById('nav-tab-agents').focus(); true`);
                const seen = [];
                for (let i = 0; i < 8; i++) { await key('Tab', 9); seen.push(await ev(`document.activeElement && document.activeElement.classList.contains('top-nav-tab') ? document.activeElement.textContent.trim().replace(/\\d+$/, '').trim() : ''`)); }
                const walked = seen.filter(Boolean);
                check('1280: the keyboard walks the tabs in the same order (Servers after Analytics, before Docs)', walked.indexOf('Servers') === walked.indexOf('Analytics') + 1 && walked.indexOf('Docs') === walked.indexOf('Servers') + 1, JSON.stringify(seen));
                await shot('nav-servers-1280');
            } else {
                await ev(`document.getElementById('nav-select').click(); true`); await settle(400);
                const list = await ev(`[...document.querySelectorAll('#nav-more-menu .nav-more-item')].map(b => b.lastElementChild.textContent.trim().replace(/\\d+$/, '').trim())`);
                check('390: the view list has them in that order', JSON.stringify(list.filter(t => WANT.includes(t))) === JSON.stringify(WANT), JSON.stringify(list));
                await shot('nav-servers-390');
            }
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})().catch(e => { console.error(e); process.exitCode = 1; });
