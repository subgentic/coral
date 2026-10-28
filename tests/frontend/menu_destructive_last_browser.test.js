// What cannot be undone is a last group of its own in the agent row's menu and the team's menu (#10282, Mobile pass 20: Kill Session sat under Move Down, Reset Team and Kill All at the foot, one slip from a thumb reaching
// for something else): a divider with at least 12 px above it, and only danger items after it; at 1280 and 390. Their confirms already name what is lost (Kill session, Reset team, Kill All, Delete team): asked of the
// real dialogs elsewhere (actions_sidebar). The agents are mocked (agent_view_harness), the menus are the real ones.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__qaSeed = [{ name: 'dm-a', prefix: 'A', n: 2, sleeping: false, board_project: 'dm-team', session_id: 'dm-a-id' }, { name: 'dm-b', prefix: 'B', n: 2, sleeping: false, board_project: 'dm-team', session_id: 'dm-b-id' }];` });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            let l = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await l;
            await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`Promise.resolve(window._coralLoadLiveSessions()).then(() => true)`);
            await waitFor(`!!document.querySelector('[data-on-click="kebab-toggle"]')`, `${w}: a row menu button`, 15000);
            // every open menu: the danger group is last, separated, with room above it
            const check = async (what, open) => {
                await ev(open);
                const m = await ev(`(() => { const menu = [...document.querySelectorAll('.sidebar-kebab-menu, .overflow-menu, .menu')].filter(e => e.getClientRects().length && e.querySelector('.menu-item-danger')).pop(); if (!menu) return null;
                    const kids = [...menu.children]; const hr = kids.findIndex(k => k.classList.contains('overflow-menu-divider-danger')); const after = hr < 0 ? [] : kids.slice(hr + 1);
                    return { hr, gap: hr < 0 ? 0 : parseFloat(getComputedStyle(kids[hr]).marginTop), onlyDanger: after.length > 0 && after.every(k => k.classList.contains('menu-item-danger')), n: kids.length, lastIsDanger: kids[kids.length - 1].classList.contains('menu-item-danger'), danger: kids.filter(k => k.classList.contains('menu-item-danger')).map(k => k.textContent.replace(/\\s+/g, ' ').trim()) }; })()`);
                assert.ok(m, `${w}: ${what}: the menu is open`);
                assert.ok(m.hr >= 0, `${w}: ${what}: a separated danger group: ${JSON.stringify(m)}`);
                assert.ok(m.gap >= 12, `${w}: ${what}: at least 12 px above its divider (${m.gap})`);
                assert.ok(m.onlyDanger && m.lastIsDanger, `${w}: ${what}: only danger items come after it: ${JSON.stringify(m)}`);
                return m;
            };
            const agent = await check('the agent row menu', `document.querySelector('.session-group-item [data-on-click="kebab-toggle"]').click(); true`);
            assert.ok(agent.danger.some(x => /Kill Session/.test(x)), `${w}: Kill Session is in it: ${JSON.stringify(agent.danger)}`);
            await shot(`menu-agent-${w}`);
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); true`);
            const team = await check('the team menu', `document.querySelector('.session-team-group [data-on-click="kebab-toggle"], .board-card-header [data-on-click="kebab-toggle"]').click(); true`);
            assert.ok(team.danger.some(x => /Kill All/.test(x)), `${w}: Kill All is in it: ${JSON.stringify(team.danger)}`);
            await shot(`menu-team-${w}`);
        }
        console.log('\nPASS the destructive items are a separated last group with room above, in the agent and team menus');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
