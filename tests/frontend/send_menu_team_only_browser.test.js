// The Send options menu offers "Send + Team Reminder" and "Send Board Protocol" only to an agent that is on a team (#16366, the Beta Tester's chat walk #16341 on v2.0.68: both were offered to an agent with no team). Desktop and phone, dark and light:
// an agent with no team sees Send and Resend Prompt only; an agent on a team sees all four. Isolated dev server with the harness's mock agents.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { themeJs } = require('./helpers/theme');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [], check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const itemsJs = `(() => { const vis = e => e.getClientRects().length > 0; const chevron = [...document.querySelectorAll('#command-toolbar [data-on-click="cmd-send-menu"], .mobile-send-options-btn')].find(vis); if (!chevron) return null; chevron.click();
        const menu = [...chevron.parentElement.querySelectorAll('.send-btn-menu')].find(m => getComputedStyle(m).display !== 'none'); return menu ? [...menu.querySelectorAll('.send-menu-item')].filter(vis).map(i => i.textContent.replace(/\\s+/g, ' ').trim()) : []; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1440', 1440, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.__m.add('solo', 'S', 3, { sleeping: false }); window.__m.add('mate', 'M', 3, { sleeping: false, board_project: 'sendteam' }); true`);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers; no single completion event
            for (const theme of ['dark', 'light']) {
                await ev(`${themeJs(theme)}; true`);
                for (const [name, onTeam] of [['solo', false], ['mate', true]]) {
                    await ev(`window.selectLiveSession(${JSON.stringify(name)}, 'claude', ${JSON.stringify(name + '-id')}, 'local'); true`);
                    await waitFor(`(() => { const c = [...document.querySelectorAll('#command-toolbar [data-on-click="cmd-send-menu"], .mobile-send-options-btn')].find(e => e.getClientRects().length); return !!c; })()`, `${label} ${theme} ${name}: the Send options button`, 10000);
                    const items = await ev(itemsJs);
                    await shot(`send-menu-${label}-${theme}-${name}`);
                    const tag = `${label} ${theme} ${name}`;
                    check(`${tag}: the menu opens with entries`, Array.isArray(items) && items.length > 0, JSON.stringify(items));
                    const team = (items || []).some(t => /team reminder/i.test(t)), proto = (items || []).some(t => /board protocol/i.test(t));
                    check(`${tag}: the team reminder is ${onTeam ? 'offered' : 'not offered'}`, team === onTeam, JSON.stringify(items));
                    check(`${tag}: the board protocol is ${onTeam && !mobile ? 'offered' : 'not offered'}`, proto === (onTeam && !mobile), JSON.stringify(items)); // the phone's menu has no board protocol entry
                    await ev(`window.closeSendMenu && window.closeSendMenu(); true`);
                }
            }
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS Send options offer the team entries only to an agent on a team');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
