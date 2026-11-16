// A search that arrives with the page (address ?q= or a reload) switches the pill to All (#16776): a Done-only match is shown, not hidden behind the Open pill.
// Real Chrome against the isolated dev server, a board with one open and one done task that share a search term.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-searchpill-${Date.now() % 100000}`;
const KEYWORD = 'zephyr';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const panel = `[role=tabpanel][id^=team-panel-]:not([hidden])`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rows = () => ev(`[...document.querySelectorAll('${panel} .dt-primary')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
    const chips = () => ev(`window.__tp.chips(/Show tasks/i)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        // create one open and one done task that share the keyword
        await ev(`(async () => {
            const B = '/api/board/${TEAM}';
            const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); };
            const open = await post('/tasks', { title: '${KEYWORD} open task', created_by: 'Operator', priority: 'medium' });
            const done = await post('/tasks', { title: '${KEYWORD} done task', created_by: 'Operator', priority: 'low' });
            await post('/tasks/' + done.id + '/complete', { subscriber_id: 'Operator', message: 'finished' });
            return true;
        })()`);
        // clear any saved filters so the default is Open
        await ev(`localStorage.removeItem('coral-task-filters:${TEAM}'); localStorage.setItem('coral-hide-completed', 'true'); true`);

        // 1. open the team page's Tasks tab with the search in the address — simulate the route
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        await goTab(ev, settle, 'Tasks');
        await waitFor(`document.querySelectorAll('${panel} .dt-primary').length >= 5`, 'the seeded tasks', 10000);

        // now re-open with a query, as the router does when the URL has ?q=
        await ev(`(async () => {
            const { openTeamPage } = await import((window.__coralStatic || '/static/') + 'team_page.js');
            await openTeamPage(${JSON.stringify(TEAM)}, { tab: 'tasks', query: 'q=${KEYWORD}' });
            return true;
        })()`);
        await waitFor(`document.querySelectorAll('${panel} .dt-primary').length > 0`, 'the search results', 10000);

        await S.run('the pill is All after a URL search', async () => {
            const pills = await chips();
            assert.ok(pills, 'the pills are visible');
            const all = pills.find(p => p.name.startsWith('All'));
            assert.ok(all, 'there is an All pill: ' + JSON.stringify(pills));
            assert.equal(all.pressed, 'true', 'the All pill is pressed (not Open): ' + JSON.stringify(pills));
        });

        await S.run('both the open and done task are shown', async () => {
            const titles = await rows();
            const hasOpen = titles.some(t => t.includes(`${KEYWORD} open`));
            const hasDone = titles.some(t => t.includes(`${KEYWORD} done`));
            assert.ok(hasOpen, 'the open task is shown: ' + JSON.stringify(titles));
            assert.ok(hasDone, 'the done task is shown (not hidden by the Open pill): ' + JSON.stringify(titles));
        });

        await S.run('the search box has the keyword', async () => {
            const val = await ev(`(document.querySelector('${panel} .list-bar-search') || {}).value || ''`);
            assert.equal(val, '${KEYWORD}', 'the search box shows the keyword');
        });

        await shot('task-search-url-pill');

        // 2. a reload (same tab, same query) also lands on All
        await ev(`(async () => {
            const { openTeamPage } = await import((window.__coralStatic || '/static/') + 'team_page.js');
            localStorage.setItem('coral-hide-completed', 'true'); // the default is Open
            await openTeamPage(${JSON.stringify(TEAM)}, { tab: 'tasks', query: 'q=${KEYWORD}' });
            return true;
        })()`);
        await waitFor(`document.querySelectorAll('${panel} .dt-primary').length > 0`, 'the reloaded results', 10000);

        await S.run('the pill is still All after a simulated reload', async () => {
            const pills = await chips();
            const all = pills.find(p => p.name.startsWith('All'));
            assert.equal(all.pressed, 'true', 'All is still pressed after reload: ' + JSON.stringify(pills));
        });

        await shot('task-search-url-pill-reload');

    } finally {
        await removeBoards(ev, TEAM);
        await client.close();
    }
    console.log('task_search_url_pill_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
