// Through Coral Hub a board link is the team page's Board tab, never the old board page (#8407, goal #38): /board/@m1/<team> (the address the Hub's Board tab used to open) redirects to
// /team/@m1/<team>/messages in place, and the Board tab there is the shared board table: Table by default, the Table | Chat switch under the search, the board's rows, and none of the old page's
// parts (Members, Pause Board, its own header). Stubbed two-computer Hub (helpers/hub_world.js) at desktop and phone width; shots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            console.log(`${w}px: the Hub's /board/@m1/same-team`);
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile });
            await Page.navigate({ url: BASE + '/board/@m1/same-team' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await waitFor(`location.pathname === '/team/@m1/same-team/messages'`, 'the board link opens the team page Messages tab', 15000);
            await waitFor(`document.querySelectorAll('#mb-messages .mb-message, #mb-messages tr').length >= 3`, 'the board rows', 15000);
            const page = await ev(`(() => { const vis = e => !!e && e.checkVisibility();
                return { team: vis(document.getElementById('team-page-view')), board: vis(document.querySelector('#team-panel-messages #mb-board')), switchLabels: [...document.querySelectorAll('.mb-table-tools button')].filter(vis).map(b => b.textContent.trim()),
                    view: document.getElementById('mb-messages').getAttribute('data-view'), oldHeader: vis(document.getElementById('messageboard-title')), members: /\\bMembers\\b/.test(document.getElementById('team-page-view').innerText), pause: /Pause Board/.test(document.getElementById('team-page-view').innerText),
                    machine: document.getElementById('team-page-title').textContent.includes('Laptop'), wide: document.documentElement.scrollWidth <= innerWidth }; })()`);
            assert.equal(page.team, true, 'the team page is on screen'); assert.equal(page.board, true, 'the board is the Messages tab\'s');
            assert.deepEqual(page.switchLabels.filter(l => l === 'Table' || l === 'Chat'), ['Table', 'Chat'], 'the Table | Chat switch is there');
            assert.equal(page.view, 'table', 'Table is the default');
            assert.equal(page.oldHeader, false, 'no old board header'); assert.equal(page.members, false, 'no Members'); assert.equal(page.pause, false, 'no Pause Board button');
            assert.equal(page.machine, true, 'the computer is named'); assert.equal(page.wide, true, 'no sideways scroll');
            assert.deepEqual(await ev(`window.__cspViolations`), [], 'no CSP violation');
            await shot(`hub-board-${w}`);
            console.log('   ✓');
        }
        console.log('PASS hub board link: /board/@m1/<team> opens the team page Messages tab with the board table (Table default, Table | Chat switch), no old page parts');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
