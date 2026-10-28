// The Details button on an artifact row is quiet (#10433, the Operator: a solid blue disc on every row): a muted outline glyph, the accent only on the row's hover, the button's hover or focus, and while its
// panel is open; the name and the 44 px hit area stay. Both widths: 1280 and 390. Shots in CORAL_SCREENSHOT_DIR.
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
   const fs2 = require('node:fs');
   const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs2.mkdirSync(d, { recursive: true }); fs2.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
   const style = () => ev(`(() => { const b = document.querySelector('#agentic-panel-artifacts .artifact-details'); const cs = getComputedStyle(b), r = b.getBoundingClientRect(), muted = (() => { const p = document.createElement('i'); p.style.color = 'var(--text-muted)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(), accent = (() => { const p = document.createElement('i'); p.style.color = 'var(--accent)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(); return { color: cs.color, muted, accent, name: b.getAttribute('aria-label'), glyph: !!b.querySelector('.material-icons'), svg: !!b.querySelector('svg'), svgFill: b.querySelector('svg') ? getComputedStyle(b.querySelector('svg')).fill : null, w: Math.round(r.width), h: Math.round(r.height) }; })()`);
   const rest = await style();
   assert.equal(rest.color, rest.muted, `${width}: at rest the Details button is the muted colour, not the accent: ` + JSON.stringify(rest));
   assert.notEqual(rest.color, rest.accent, `${width}: not the accent at rest`);
   assert.ok(rest.svg && !rest.glyph, `${width}: an outline glyph (an SVG with no fill), not the filled font disc: ` + JSON.stringify(rest));
   assert.equal(rest.svgFill, 'none', `${width}: the glyph is an outline`);
   assert.match(rest.name, /^Details for /, `${width}: the name stays`);
   assert.ok(rest.h >= (width === 390 ? 44 : 28) && rest.w >= (width === 390 ? 44 : 28), `${width}: the hit area stays: ` + JSON.stringify(rest));
   await shot(`details-rest-${width}`);
   if (width === 1280) {
      const c = await ev(`(() => { const b = document.querySelector('#agentic-panel-artifacts .artifact-details'); const row = b.closest('tr'); row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`);
      const pt = await ev(`(() => { const r = document.querySelector('#agentic-panel-artifacts tbody .dt-row .dt-primary').getBoundingClientRect(); return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) }; })()`);
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: pt.x, y: pt.y }); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the hover transition
      const hov = await style();
      assert.equal(hov.color, hov.accent, `${width}: the row's hover brings the full colour: ` + JSON.stringify(hov));
      await shot(`details-row-hover-${width}`);
   }
   console.log('PASS quiet Details button ' + width);
  } catch (error) { failures.push(width + ': ' + error.message); console.error(failures.at(-1)); } }
  assert.equal(failures.length, 0, failures.join('\n'));
 } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
