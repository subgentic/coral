// #17129: a repository without a comparison branch still explains its history.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const TEAM = `qa-no-base-${Date.now() % 100000}`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [390, 1280]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install(); await coralReady(ev); await installTP(ev); await seed(ev, TEAM);
            await ev(`(() => { const real = window.fetch; const answer = {available:true,repos:[{base:'',worktrees:[{branch:'lisbon-planner',main:true,head:'abc123456789',changed:0,untracked:0,commit_count:3,agents:[{session_id:'one',name:'trip-walk49',display_name:'Trip planner'},{session_id:'two',name:'trip-walk49',display_name:'Researcher'}]},{branch:'remote-folder',not_local:true,changed:0,untracked:0},{branch:'old-server',changed:2,untracked:1},{branch:'large-history',commit_count:1001,changed:0,untracked:0},{branch:'empty-history',commit_count:0,changed:0,untracked:0}]}]}; window.fetch = (u,o) => String(u).split('?')[0].endsWith('/branches') ? Promise.resolve(new Response(JSON.stringify(answer),{status:200,headers:{'Content-Type':'application/json'}})) : real(u,o); })()`);
            await ev(`window.openTeamPage(${JSON.stringify(TEAM)}, {tab:'branches'})`);
            await waitFor(`!!document.querySelector('#team-panel-branches .branches-row')`, 'Branch row'); await ev(framesJs(3));
            const result = await ev(`(() => { const p=document.getElementById('team-panel-branches'); return {text:p.textContent,left:p.querySelector('.branches-row').getBoundingClientRect().left,overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
            const cases = await ev(`(() => { const rows=[...document.querySelectorAll('#team-panel-branches .branches-row')]; const find=name=>rows.find(r=>r.querySelector('.branches-name').textContent.includes(name)); return { remote:find('remote-folder')?.textContent, older:find('old-server')?.textContent, measured:find('lisbon-planner')?.querySelector('.branches-changes')?.getAttribute('title'), minimumLeft:Math.min(...rows.map(r=>r.getBoundingClientRect().left)) }; })()`);
            if (!/Commit history not counted for this folder/.test(cases.remote) || /could not be counted/.test(cases.remote)) failures.push(width + ': non-local folder is not a count failure: ' + cases.remote);
            if (/commit|could not be counted|^ ·/.test(cases.older) || !/2 changed, 1 untracked/.test(cases.older)) failures.push(width + ': old-server count should be omitted: ' + cases.older);
            if (!/3 commits in branch history/.test(result.text) || !/inherited/.test(cases.measured)) failures.push(width + ': count must describe inherited branch history');
            if (!/1000\+ commits in branch history/.test(result.text) || !/0 commits in branch history/.test(result.text)) failures.push(width + ': cap and zero are honest history counts');
            if (cases.minimumLeft < 12) failures.push(width + ': left gutter missing on a row');
            if (!/3 commits/.test(result.text)) failures.push(width + ': history missing: ' + result.text);
            if (!/Trip planner, Researcher/.test(result.text)) failures.push(width + ': agent names missing');
            if (/main worktree|counts are not shown/.test(result.text)) failures.push(width + ': jargon or misleading missing-count text');
            if (result.left < 12 || result.overflow) failures.push(width + ': spacing or overflow');
            if (process.env.CORAL_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
                fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/branches-${width}.png`, Buffer.from((await Page.captureScreenshot({ format:'png' })).data, 'base64'));
            }
        }
        assert.deepEqual(failures, []);
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
