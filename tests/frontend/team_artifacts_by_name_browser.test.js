// A team's Artifacts tab opened by the team's NAME (/team/<name>/artifacts) lists its files (#8798): the board routes resolve the name to the board's id and answer with the id, and the page used to take that
// for another team's answer ("Unable to load artifacts: unexpected response scope"). The page accepts the id of the board the name's label names, and still refuses an answer for any other board. Against a stubbed
// board route (the answer names the board by its id). 1280 and 390. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const LABEL = 'Name Team ' + Date.now().toString(36), ID = 'b-name' + Date.now().toString(36).slice(-6).padEnd(6, '0');
const ITEMS = ['plan.md', 'notes.md'].map((name, i) => ({ name, media_type: 'text/markdown', size: 2048 + i, task_id: 100 + i, task_title: 'Task ' + i, produced_by: 'qa-bot', created_at: new Date(Date.now() - i * 60000).toISOString(), uri: 'coral://artifacts/' + String(i + 1).repeat(64).slice(0, 64) }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const rows = () => ev(`document.querySelectorAll('#team-panel-artifacts tbody tr').length`);
    const err = () => ev(`(document.querySelector('#team-panel-artifacts .team-artifacts-error') || {}).textContent || ''`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            // Cold deep link: the artifact answer arrives before the board list can teach the page its label (#8804).
            const coldLabel = LABEL + ' cold ' + w;
            const delayed = await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
                const R = window.fetch; const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
                let release; const labels = new Promise(r => { release = r; });
                window.__releaseLabels = () => release(); window.__artifactReads = 0;
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                    if (url.pathname === '/api/board/projects') return labels.then(() => json([{ project: ${JSON.stringify(ID)}, board_label: ${JSON.stringify(coldLabel)} }]));
                    if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname)) { window.__artifactReads++; return Promise.resolve(json({ project: ${JSON.stringify(ID)}, artifacts: ${JSON.stringify(ITEMS)}, total: 2, all: 2 })); }
                    return R(u, o); };
            })()` });
            await Page.navigate({ url: BASE + '/team/' + encodeURIComponent(coldLabel) + '/artifacts' }); await Page.loadEventFired(); await install();
            await waitFor(`window.__artifactReads > 0 && !!document.querySelector('#team-panel-artifacts .team-count-line')`, `${label}: the cold artifact answer`, 10000);
            await waitFor(`!!document.querySelector('#team-panel-artifacts .team-artifacts-error') || /Loading/.test(document.querySelector('#team-panel-artifacts .team-count-line')?.textContent || '')`, `${label}: the first answer is handled`, 5000);
            check(`${label}: no scope error and no unverified rows while the label is unknown`, (await rows()) === 0 && (await err()) === '', `${await rows()} rows; ${await err()}`);
            await ev(`window.__labelRead = import((window.__coralStatic || '/static/') + 'board_fetch.js').then(m => m.fetchProjects()); window.__releaseLabels(); true`);
            await waitFor(`document.querySelectorAll('#team-panel-artifacts tbody tr').length === 2 || !!document.querySelector('#team-panel-artifacts .team-artifacts-error')`, `${label}: artifacts after the labels arrive`, 10000);
            check(`${label}: labels arriving recover the cold link automatically, without navigation or Refresh`, (await rows()) === 2 && (await err()) === '', `${await rows()} rows; ${await err()}`);
            await Page.removeScriptToEvaluateOnNewDocument({ identifier: delayed.identifier });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            for (const answerId of [ID, 'b-someoneelse0']) {
                await ev(`(async () => { const S = window.__coralStatic || '/static/'; const sb = await import(S + 'server_base.js'); sb.noteBoardLabels([{ board_id: ${JSON.stringify(ID)}, board_label: ${JSON.stringify(LABEL)} }], 'board_id', 'local');
                    window.__answerId = ${JSON.stringify(answerId)}; if (!window.__stubbed) { window.__stubbed = true; const R = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                            if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname) && (o.method || 'GET') === 'GET') return json({ project: window.__answerId, artifacts: ${JSON.stringify(ITEMS)}, limit: 50, offset: 0, has_more: false, truncated: false, total: 2, all: 2 });
                            if (url.pathname === '/api/system/artifact-store/kept') return json({ kept: [] });
                            return R(u, o); }; } return true; })()`);
                await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(LABEL)}, { tab: 'artifacts' }); true`);
                await waitFor(`!!document.querySelector('#team-panel-artifacts') && !document.querySelector('#team-panel-artifacts').hidden`, `${label}: the Artifacts tab`, 10000);
                await settle(900);
                if (answerId === ID) check(`${label}: opened by name, the answer for the board the name's label names lists its two files, with no error`, (await rows()) === 2 && (await err()) === '', `${await rows()} rows; ${await err()}`);
                else check(`${label}: an answer for another board is still refused ("unexpected response scope")`, (await rows()) === 0 && /unexpected response scope/.test(await err()), `${await rows()} rows; ${await err()}`);
            }
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} team artifacts by-name checks passed`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
