// #8931: every artifact surface shares sortable one-line columns; narrow lists drop optional metadata.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const HEX = n => n.toString(16).padStart(2, '0').repeat(32);
const TEAM = 'aa-team-' + Date.now().toString(36);
const DATA = ['a-very-long-artifact-filename-that-must-end-in-an-ellipsis.txt', 'bravo.pdf', 'charlie.txt'].map((name, i) => ({ id: HEX(i + 1), name, media_type: ['image/png', 'application/pdf', 'text/plain', 'application/zip', 'image/png', 'text/markdown', 'text/plain'][i], size: (i + 1) * 300,
    tags: ['for review', 'internal', 'approved'], task_id: 101, task_title: 'Task ' + (i + 1), created_at: new Date(Date.UTC(2026, 9, 10 - i, 10)).toISOString(), uri: 'coral://artifacts/' + HEX(i + 1), available: true, inline: false, reference_count: 1, source: 'task', produced_by: 'Dev One' }));

const STUB = `(() => {
    const R = window.fetch; window.__req = []; window.__data = ${JSON.stringify(DATA)};
    const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin); const q = url.searchParams;
        const m = url.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts$/);
        if (m && (o.method || 'GET').toUpperCase() === 'GET') {
            window.__req.push({ kind: 'board', project: decodeURIComponent(m[1]), query: Object.fromEntries(q.entries()) });
            let items = window.__data.slice();
            if (q.get('q')) { const t = q.get('q').toLowerCase(); items = items.filter(i => [i.name, i.task_title, i.produced_by, i.media_type].some(x => (x || '').toLowerCase().includes(t))); }
            if (q.get('kind')) { const k = q.get('kind'); items = items.filter(i => (i.media_type.startsWith('image/') ? 'image' : i.media_type === 'application/pdf' ? 'pdf' : i.media_type.startsWith('text/') ? 'text' : 'other') === k); }
            const sort = q.get('sort') || 'newest';
            items.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'oldest' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at));
            const total = items.length, offset = Number(q.get('cursor') || q.get('offset') || 0), pageSize = window.__pageSize || items.length;
            const body = { project: decodeURIComponent(m[1]), artifacts: items.slice(offset, offset + pageSize), has_more: offset + pageSize < total, next_cursor: offset + pageSize < total ? String(offset + pageSize) : '', truncated: false };
            if (q.get('session_id')) body.session_id = q.get('session_id');
            if (q.has('sort')) { body.total = items.length; body.all = window.__data.length; }
            return json(body);
        }
        if (window.__tasks && url.pathname === '/api/board/' + ${JSON.stringify(TEAM)} + '/tasks') return json({tasks:window.__tasks,total_open:window.__tasks.length,total_completed:0,has_more:false});
        if (window.__tasks && url.pathname.endsWith('/tasks') && url.pathname.startsWith('/api/sessions/live/')) return json([]);
        if (url.pathname === '/api/session-artifacts') { window.__req.push({ kind: 'standalone', query: Object.fromEntries(q.entries()) }); return json({ session_id: q.get('session_id'), artifacts: window.__data.slice(0, 3), has_more: false, truncated: false }); }
        if (url.pathname === '/api/system/artifact-store/kept') return json({ kept: [] });
        return R(u, o);
    };
    return true;
})()`;

(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const failures=[];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for (const width of [1280,390]) { try {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await ev(`window.__coralReady.then(()=>true)`);await ev(STUB);
   await ev(`(async()=>{const S=window.__coralStatic||'/static/';const {state}=await import(S+'state.js');const files=await import(S+'changed_files.js');const {showView}=await import(S+'utils.js');state.currentSession={type:'live',name:'aa-agent',session_id:'aa-1',board_project:${JSON.stringify(TEAM)}};showView('live-session-view');const side=document.getElementById('agentic-state');side.classList.remove('collapsed');files.initFileSearch();files.syncFilesViewerSession();return true;})()`);
   await ev(`(()=>{const side=document.getElementById('agentic-state');if(innerWidth<=767&&side.getBoundingClientRect().width===0)(document.getElementById('popout-panel-toggle-btn')||document.getElementById('panel-toggle-btn')).click();window.switchAgenticTab('artifacts','top');return true;})()`);
   await waitFor(`document.querySelectorAll('#agentic-panel-artifacts tbody tr').length===3`,'artifact rows');
   const seen=await ev(`(() => { const table=document.querySelector('#agentic-panel-artifacts .dt-table'); return {keys:[...table.querySelectorAll('thead th[data-key]')].map(h=>h.dataset.key), rows:[...table.querySelectorAll('tbody .dt-row')].map(r=>({height:r.getBoundingClientRect().height, cells:[...r.cells].filter(c=>c.getClientRects().length).map(c=>({key:c.dataset.key,y:c.getBoundingClientRect().y})), tags:r.querySelector('[data-key=tags]')?.textContent})), folded:table.closest('.dt-box').classList.contains('dt-folded')}; })()`);
   assert.deepEqual(seen.keys,['name','type','tags','size','updated','details']);
   assert.equal(seen.folded,false);
   for(const row of seen.rows){assert.ok(row.height<=56);assert.ok(row.cells.every(c=>Math.abs(c.y-row.cells[0].y)<2));assert.ok(row.tags.includes('+1'));if(width===390)assert.deepEqual(row.cells.map(c=>c.key),['name','updated','details']);}
   await ev(`document.querySelector('#agentic-panel-artifacts .dt-sort[data-key=name]').click();true`);
   assert.equal(await ev(`document.querySelector('#agentic-panel-artifacts th[data-key=name]').getAttribute('aria-sort')`),'ascending');
   await ev(`document.querySelector('#agentic-panel-artifacts .dt-sort[data-key=name]').click();true`);
   assert.equal(await ev(`document.querySelector('#agentic-panel-artifacts th[data-key=name]').getAttribute('aria-sort')`),'descending');
   assert.equal(await ev(`document.querySelector('#agentic-panel-artifacts tbody .dt-primary').textContent`),'charlie.txt');
   const dir=process.env.CORAL_SCREENSHOT_DIR||(process.env.RUNNER_TEMP&&path.join(process.env.RUNNER_TEMP,'out'));if(dir){fs.mkdirSync(dir,{recursive:true});for(const theme of ['light','dark']){await setTheme(ev,theme);fs.writeFileSync(path.join(dir,`shared-artifact-table-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
   await ev(`document.querySelector('#agentic-panel-artifacts .artifact-details').click();true`);
   await waitFor(`!document.getElementById('agentic-detail-pane').hidden`,'Details opens existing sheet');
   assert.ok(await ev(`document.getElementById('agentic-detail-pane').textContent.includes('MIME')`),'type remains in Details');
  }catch(e){failures.push(width+': '+e.message);console.error(failures.at(-1));}}
  // The embedded task/goal sections and the team page mount the same columns, with no folded fallback.
  for (const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   for (const surface of ['team','task','goal']) {
    await ev(`(async()=>{const S=window.__coralStatic||'/static/';document.getElementById('artifact-surfaces-test')?.remove();const host=document.createElement('div');host.id='artifact-surfaces-test';host.style.cssText='position:fixed;inset:0;background:var(--bg-primary);z-index:1000;overflow:auto';document.body.append(host);
     if(${JSON.stringify(surface)}==='team'){const m=await import(S+'team_artifacts_page.js');await m.createArtifactsList().showArtifacts(host,${JSON.stringify(TEAM)});}
     if(${JSON.stringify(surface)}==='task'){const m=await import(S+'team_task_artifacts.js');host.append(await m.taskArtifactsSection(${JSON.stringify(TEAM)},{id:101}));}
     if(${JSON.stringify(surface)}==='goal'){const m=await import(S+'goal_artifacts.js');m.mountGoalArtifacts(host,{team:${JSON.stringify(TEAM)},goalId:1});}
     return true;})()`);
    if(surface==='goal'){await waitFor(`!document.querySelector('#artifact-surfaces-test details').hidden`,'goal artifact count');await ev(`document.querySelector('#artifact-surfaces-test details').open=true;true`);}
    await waitFor(`document.querySelectorAll('#artifact-surfaces-test tbody .dt-row').length===3`,surface+' artifact rows');
    assert.equal(await ev(`document.querySelector('#artifact-surfaces-test .dt-box').classList.contains('dt-one-line')`),true,surface);
    assert.equal(await ev(`document.querySelector('#artifact-surfaces-test th[data-key=name]').getAttribute('aria-sort')`),surface==='goal'?'none':'descending',surface==='goal'?'the goal list is grouped by task: its heads stay until a header is pressed on it':'sort remembered across '+surface);
    assert.equal(await ev(`document.querySelector('#artifact-surfaces-test tbody .dt-primary').textContent`),surface==='goal'?DATA[0].name:'charlie.txt');
    assert.equal(await ev(`!!document.querySelector('#artifact-surfaces-test .dt-folded')`),false,surface+' never folds');
   }
  }
  assert.deepEqual(failures,[]);
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
