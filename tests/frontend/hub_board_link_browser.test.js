// Through Coral Hub a board link is the team page's Board tab, never the old board page (#8407, goal #38): /board/@m1/<team> (the address the Hub's Board tab used to open) redirects to
// /team/@m1/<team>/board in place, and the Board tab there is the shared board table: Table by default, the Table | Chat switch under the search, the board's rows, and none of the old page's
// parts (Members, Pause Board, its own header). Stubbed two-computer Hub (helpers/hub_world.js) at desktop and phone width; shots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && require('node:path').join(process.env.RUNNER_TEMP, 'out', 'shots')); if (!dir) return; fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            console.log(`${w}px: the Hub's /board/@m1/same-team`);
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile });
            await Page.navigate({ url: BASE + '/board/@m1/same-team' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await waitFor(`location.pathname === '/team/@m1/same-team/board'`, 'the board link opens the team page Messages tab', 15000);
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
            // #8435: the page can fit while its nested message scroller still overflows.
            // A full date/time must fit its cell, not merely exist in textContent.
            await ev(`document.fonts.ready.then(() => true)`);
            const geometry = await ev(`(() => {
                const list = document.getElementById('mb-messages');
                return { scroll: list.scrollWidth, client: list.clientWidth,
                    times: [...list.querySelectorAll('.mb-row-toggle .message-time')].filter(e => e.checkVisibility()).map(e => {
                        const range = document.createRange(); range.selectNodeContents(e);
                        const text = range.getBoundingClientRect(), cell = e.getBoundingClientRect(), row = e.closest('.mb-row-toggle').getBoundingClientRect();
                        return { value: e.textContent, textLeft: text.left, textRight: text.right, cellLeft: cell.left, cellRight: cell.right, rowRight: row.right, listRight: list.getBoundingClientRect().right };
                    }) };
            })()`);
            assert.equal(geometry.scroll, geometry.client, `${w}: the board's own scroller has no horizontal overflow: ${JSON.stringify(geometry)}`);
            assert.ok(geometry.times.length >= 3, `${w}: visible message timestamps measured`);
            for (const t of geometry.times) assert.ok(t.textLeft >= t.cellLeft - 1 && t.textRight <= t.cellRight + 1 && t.textRight <= t.rowRight + 1 && t.textRight <= t.listRight + 1,
                `${w}: the whole timestamp fits its cell and board: ${JSON.stringify(t)}`);
            console.log('   ✓');
        }
        console.log('PASS hub board link: /board/@m1/<team> opens the team page Messages tab with the board table (Table default, Table | Chat switch), no old page parts');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
