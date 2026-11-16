// #16873: two teams have the same agent name; row identity leads with team, and filters close on Clear/navigation.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const problems = [];
    const check = (ok, message) => { if (!ok) problems.push(message); };
    const shot = async name => { const dir=process.env.CORAL_IDENTITY_SHOTS;if(!dir)return;const fs=require('node:fs');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/'+name+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'settings');
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`);
            await ev(`(()=>{const real=window.fetch.bind(window);window.fetch=(u,o)=>{const url=new URL(String(u&&u.url||u),location.origin);if(url.pathname==='/api/goals'){const goals=url.searchParams.get('state')==='done'?['alpha-team','beta-team'].map((board_id,i)=>({id:7101+i,board_id,title:'Finish '+board_id,state:'done',created_by:'Orchestrator',closed_by:'Orchestrator',closed_at:new Date().toISOString(),closed_reason:'The work is ready.'})):[];return Promise.resolve(new Response(JSON.stringify({goals}),{status:200,headers:{'content-type':'application/json'}}))}return real(u,o)};return true})()`);
            await ev(`(async () => { window.__m.agents = {}; window.__m.add('perm-bot', 'A', 1, { sleeping: false, board_project: 'alpha-team' }); window.__m.add('ask-bot', 'B', 1, { sleeping: false, board_project: 'beta-team' }); const ws = await import(${S} + 'websocket.js'); const { state } = await import(${S} + 'state.js'); if (state.coralWs) { state.coralWs.onclose = null; state.coralWs.onmessage = null; try { state.coralWs.close(); } catch {} }
                const sessions = Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), display_name: 'Orchestrator', waiting_for_input: true, waiting_kind: /perm/.test(a.name) ? 'permission' : 'question', waiting_summary: /perm/.test(a.name) ? 'Wants to use Bash' : 'Wants to know: Pick a color', waiting_since: new Date(Date.now() - 60000).toISOString() }));
                ws.handleCoralMessage({ type: 'coral_update', servers: [], sessions }); return true; })()`);
            const openNeeds = async () => { await ev(`window.switchNavTab('hub-inbox'); true`); await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await waitFor(`document.getElementById('group-table-view') && document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view tbody tr:not(.dt-group), #group-table-view .dt-mail-row, #group-table-view [data-row-key]').length >= 2`, `${w}: the two waiting agents`, 10000); };
            await openNeeds();
            await waitFor(`document.getElementById('group-table-view').innerText.includes('Goal #7101') && document.getElementById('group-table-view').innerText.includes('Goal #7102')`, 'closed-goal notices', 10000);
            const names = await ev(`[...document.querySelectorAll('#group-table-view .dt-mail-title, #group-table-view .dt-primary, #group-table-view .inbox-review-from, #group-table-view .inbox-review-name')].map(n=>n.textContent.trim())`);
            for (const [i,team] of ['alpha-team','beta-team'].entries()) {
                check(names.some(t=>t.startsWith(team+' · Orchestrator')), `${w}: agent identity leads with ${team}: ${JSON.stringify(names)}`);
                check(names.some(t=>t.startsWith(team+' · Goal #'+(7101+i))), `${w}: closed goal names ${team}: ${JSON.stringify(names)}`);
            }
            await settle(200); await shot('list-'+w);
            await ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills button')].find(b=>/^Permission/.test(b.textContent.trim())).click();true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length===1`, 'permission-only row', 5000);
            const only = await ev(`[...document.querySelectorAll('#group-table-view .dt-primary, #group-table-view .dt-mail-title, #group-table-view .inbox-review-from')].map(n=>n.textContent.trim())`);
            check(only.some(t=>t.startsWith('alpha-team · Orchestrator')), `${w}: agent-only layout retains team identity: ${JSON.stringify(only)}`);
            await ev(`document.querySelector('#inbox-needs-menu .list-bar-clear-all').click();true`);
            await waitFor(`document.getElementById('group-table-view').innerText.includes('Goal #7101')`, 'all kinds restored', 5000);
            const toggle = '#inbox-needs-toggle';
            check((await ev(`document.querySelector('${toggle}').innerText`)).includes('Filter'), `${w}: visible filter label`);
            await ev(`document.querySelector('${toggle}').click();true`);
            await waitFor(`document.querySelector('${toggle}').getAttribute('aria-expanded')==='true'`, 'filter open');
            await settle(200); await shot('filters-'+w);
            await ev(`document.querySelector('#inbox-needs-menu .list-bar-clear-all').click();true`);
            await settle(150);
            check(await ev(`document.querySelector('${toggle}').getAttribute('aria-expanded')==='false'`), `${w}: Clear closes panel`);
            await ev(`if(document.querySelector('${toggle}').getAttribute('aria-expanded')!=='true')document.querySelector('${toggle}').click();window.switchNavTab('agents');true`);
            await openNeeds();
            check(await ev(`document.querySelector('${toggle}').getAttribute('aria-expanded')==='false'`), `${w}: navigation closes filter`);
        }
        assert.deepEqual(problems, []);
        console.log('PASS team identity leads each row and filters close');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
