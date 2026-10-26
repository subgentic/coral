// The Inbox's folders and the team's Board tab have addresses of their own (#8652, audit #8572 point 4): /inbox/needs, /inbox/saved and /inbox/chats/<all|active|starred|...> follow the folder the person opens
// (a click writes the path, Back goes to the folder before it, a reload and a pasted link open the folder), and the team's Board tab is /team/<team>/board, with the old /messages address read as the Board tab
// and rewritten to /board. At 1280 and at 390 (the phone's folder select). Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-paths-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const path = () => ev(`location.pathname`);
    const title = () => ev(`(document.getElementById('group-table-title') || {}).textContent || ''`);
    const inboxReady = () => waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the Inbox folders', 10000);
    const folderTitle = want => waitFor(`((document.getElementById('group-table-title') || {}).textContent || '').trim() === ${JSON.stringify(want)}`, `the ${want} page`, 8000);
    const pickFolder = (key, mobile) => mobile
        ? ev(`(() => { const s = document.querySelector('.view-list select'); s.value = ${JSON.stringify(key)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`)
        : ev(`document.querySelector('.view-list-item[data-key="${key}"]').click(); true`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });

            // a folder written as the person opens it
            await load('/');
            await ev(`window.switchNavTab('hub-inbox'); true`); await inboxReady(); await settle(300);
            await pickFolder('needs', mobile); await folderTitle('Needs you');
            check(`${label}: opening Needs you writes /inbox/needs`, (await path()) === '/inbox/needs', await path());
            await pickFolder('saved', mobile); await folderTitle('Saved');
            check(`${label}: opening Saved writes /inbox/saved`, (await path()) === '/inbox/saved', await path());
            await pickFolder('chats-starred', mobile); await folderTitle('Starred');
            check(`${label}: opening Starred writes /inbox/chats/starred`, (await path()) === '/inbox/chats/starred', await path());
            await pickFolder('chats', mobile); await folderTitle('All chats');
            check(`${label}: All chats is /inbox/chats/all`, (await path()) === '/inbox/chats/all', await path());

            // Back goes to the folder before, and shows it
            await ev(`history.back(); true`); await folderTitle('Starred');
            check(`${label}: Back from All chats shows Starred, at its path`, (await path()) === '/inbox/chats/starred', await path());
            await ev(`history.back(); true`); await folderTitle('Saved');
            check(`${label}: Back again shows Saved`, (await path()) === '/inbox/saved', await path());
            await ev(`history.forward(); true`); await folderTitle('Starred');
            check(`${label}: Forward shows Starred again`, (await path()) === '/inbox/chats/starred', await path());

            // a reload and a pasted link open the folder
            await load('/inbox/chats/starred'); await inboxReady(); await folderTitle('Starred');
            check(`${label}: a reload of /inbox/chats/starred opens Starred and keeps the address`, (await path()) === '/inbox/chats/starred', await path());
            await load('/inbox/saved'); await inboxReady(); await folderTitle('Saved');
            check(`${label}: a link to /inbox/saved opens Saved`, (await path()) === '/inbox/saved', await path());
            await load('/inbox/chats/cli-codex'); await inboxReady(); await folderTitle('Codex');
            check(`${label}: a link to a CLI folder opens it (/inbox/chats/cli-codex)`, (await path()) === '/inbox/chats/cli-codex', await path());
            await load('/inbox/chats/nonsense'); await settle(500);
            check(`${label}: a path that is not a folder is not an Inbox page (it goes to the start)`, (await path()) !== '/inbox/chats/nonsense', await path());
            const n0 = await ev(`history.length`);
            await load('/chats'); await inboxReady(); await folderTitle('All chats'); const n1 = await ev(`history.length`);
            check(`${label}: the old /chats address opens All chats and is replaced by /inbox/chats/all, with no extra Back entry (one entry for the visit)`, (await path()) === '/inbox/chats/all' && n1 === n0 + 1, `${await path()} ${n0} -> ${n1}`);

            await load('/chats?q=routeclick'); await inboxReady(); await folderTitle('All chats');
            check(`${label}: a /chats link that carries a search keeps its address (the filters are in it)`, (await path()) + (await ev(`location.search`)) === '/chats?q=routeclick', (await path()) + (await ev(`location.search`)));

            // the team's Board tab
            await load('/');
            await installTP(ev); await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM);
            await goTab(ev, settle, 'Board'); await settle(500);
            check(`${label}: the team's Board tab is /team/<team>/board`, (await path()) === `/team/${TEAM}/board`, await path());
            await ev(`location.reload(); true`); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await waitFor(`!!document.querySelector('#team-panel-messages') && !document.querySelector('#team-panel-messages').hidden`, 'the Board tab after a reload', 10000);
            check(`${label}: a reload of /team/<team>/board opens the Board tab`, (await path()) === `/team/${TEAM}/board`, await path());
            await load(`/team/${TEAM}/messages`);
            await waitFor(`!!document.querySelector('#team-panel-messages') && !document.querySelector('#team-panel-messages').hidden`, 'the Board tab from the old address', 10000);
            check(`${label}: the old /messages address opens the Board tab and is rewritten to /board`, (await path()) === `/team/${TEAM}/board`, await path());
        }
    } finally { await removeBoards?.(ev, [TEAM]).catch?.(() => {}); await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox and Board path checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
