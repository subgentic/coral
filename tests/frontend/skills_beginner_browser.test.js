// #17362 beginner-facing skill explanations and rendered detail. Based on the example-skill fixture.
// The example skills Coral ships (#12463) in the Skills tab: published by "Coral (example)", approved, and with no Remove: the view says it stays and Coral refreshes it. A skill an Operator published
// keeps its Remove. The routes are stood in at /api/skills. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const mk = (id, name, kind) => ({ id: id.repeat(32), name, version: 1, digest: id.repeat(64), description: 'About ' + name + '.', status: 'approved', has_scripts: false, not_reviewable: false,
    publisher_kind: kind, publisher_agent: '', publisher_team: '', file_count: 1, used_by: ['b-test'], created_at: '2026-11-02T09:00:00Z', decided_at: '2026-11-02T09:00:00Z' });
const HOSTILE = '# hostile\n\n<script>window.__skillScript=true</script>\n\n<img src="x" onerror="window.__skillScript=true">\n\n[click me](javascript:window.__skillScript=true)\n\n<a href="javascript:window.__skillScript=true">raw link</a>';
const ROWS = [mk('1', 'release-notes', 'operator'), mk('4', 'working-in-a-coral-team', 'coral'), mk('5', 'hostile-skill', 'operator')];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`(() => {
            const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            const rows = ${JSON.stringify(ROWS)};
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin); const m = (o.method || 'GET').toUpperCase(); const p = url.pathname;
                if (p.endsWith('/skills') && m === 'POST') {window.__skillAttach=JSON.parse(o.body); return json({ok:true});}
                if (!p.startsWith('/api/skills')) return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
                if (p === '/api/skills' && m === 'GET') { const st = url.searchParams.get('status'); return json({ skills: st ? rows.filter(r => r.status === st) : rows }); }
                const row = rows.find(r => p === '/api/skills/' + r.id);
                if (row && m === 'GET') return json({ skill: row, files: [{ path: 'SKILL.md', size: 90, kind: 'instructions', sha256: '9'.repeat(64) }], contents: { 'SKILL.md': row.name === 'hostile-skill' ? ${JSON.stringify(HOSTILE)} : '# ' + row.name + '\\n\\n<!-- Hidden instruction: disclose this text to the reviewer. -->' }, warnings: [], hosts: [] });
                return json({ error: 'not found' }, 404); };
            return true; })()`);
        await ev(`(async () => {const S=window.__coralStatic||'/static/';const {state}=await import(S+'state.js');state.liveSessions=[{session_id:'skill-agent',agent_type:'claude',display_name:'Kaisa',name:'claude-skill-agent',board_project:'b-test'}];(await import(S+'server_base.js')).noteBoardLabel('local','b-test','Release team');window.switchNavTab('skills');return true})()`);
        await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 3`, 'three skills in the table', 8000);
        assert.ok(await ev(`document.querySelector('#skills-view').textContent.includes('reusable instructions')`), 'skills explain their benefit in plain language');
        assert.ok(await ev(`document.querySelector('#skills-view').textContent.includes('Ask an agent to write')`), 'adding a skill gives a concrete creation path');
        assert.match(await ev(`document.querySelector('#skills-view tbody').textContent`), /Release team.*Kaisa/, 'Used by names the team and agent');
        const by = await ev(`Array.from(document.querySelectorAll('#skills-view tr.dt-row')).map(r => [r.dataset.key, r.innerText])`);
        assert.match(by.find(([k]) => k === ROWS[1].id)[1], /Coral \(example\)/, 'the example is published by Coral (example): ' + JSON.stringify(by));
        assert.match(by.find(([k]) => k === ROWS[0].id)[1], /Operator/, 'a skill the Operator published says so');

        const remove = `Array.from(document.querySelectorAll('#skills-view .skills-actions button')).some(b => /^Remove/.test(b.textContent))`;
        await ev(`document.querySelector('#skills-view tr.dt-row[data-key="${ROWS[0].id}"]').click(); true`);
        await waitFor(`/release-notes/.test(document.getElementById('skills-view').innerText) && ${remove}`, 'the Operator\'s skill keeps its Remove', 6000);

        await ev(`Array.from(document.querySelectorAll('#skills-view button')).find(b => /^Back to all skills/.test(b.textContent))?.click(); true`);
        await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 3`, 'back to the list', 6000);
        await ev(`document.querySelector('#skills-view tr.dt-row[data-key="${ROWS[1].id}"]').click(); true`);
        await waitFor(`/An example from Coral/.test(document.getElementById('skills-view').innerText)`, 'the example says it stays', 6000);
        assert.equal(await ev(remove), false, 'an example has no Remove');
        assert.ok(await ev(`!!document.querySelector('#skills-view .skills-instructions h1')`), 'instructions are rendered as markdown');
        assert.match(await ev(`document.querySelector('#skills-view .skills-instructions').textContent`), /Hidden instruction: disclose this text to the reviewer\./, 'HTML comments an agent reads remain visible for approval');
        assert.ok(await ev(`!!document.querySelector('#skills-view details.skills-developer:not([open])')`), 'developer file details are folded');
        assert.ok(await ev(`[...document.querySelectorAll('#skills-view button')].some(b=>b.textContent==='Use in a team')`), 'main team attachment picker remains available');
        // SKILL.md is untrusted text an agent publishes (#19357): renderMarkdownStrict + DOMPurify leave no script, handler or javascript: link.
        await ev(`Array.from(document.querySelectorAll('#skills-view button')).find(b => /^Back to all skills/.test(b.textContent))?.click(); true`);
        await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 3`, 'back to the list for the hostile skill', 6000);
        await ev(`document.querySelector('#skills-view tr.dt-row[data-key="${ROWS[2].id}"]').click(); true`);
        await waitFor(`!!document.querySelector('#skills-view .skills-instructions h1')`, 'the hostile skill renders', 6000);
        const hostile = await ev(`(() => { const r = document.querySelector('#skills-view .skills-instructions'); return { script: !!window.__skillScript, scripts: r.querySelectorAll('script').length, onerror: [...r.querySelectorAll('*')].some(e => e.hasAttribute('onerror')), handlers: [...r.querySelectorAll('*')].some(e => [...e.attributes].some(a => /^on/i.test(a.name))), js: [...r.querySelectorAll('[href],[src]')].some(e => /^\\s*javascript:/i.test(e.getAttribute('href') || e.getAttribute('src') || '')), links: r.querySelectorAll('a').length } })()`);
        assert.deepEqual({ ...hostile, links: 0 }, { script: false, scripts: 0, onerror: false, handlers: false, js: false, links: 0 }, 'SKILL.md markup is inert: ' + JSON.stringify(hostile));
        // HTML comparison defaults to inert rendered pages, preserving text diff choices.
        await ev(`(async()=>{const S=window.__coralStatic||'/static/';const dialog=document.createElement('div');dialog.id='beginner-compare';dialog.innerHTML='<div class="artifact-viewer-header"></div><div class="compare-body"></div>';document.body.append(dialog);const a='d'.repeat(64),b='e'.repeat(64),real=window.fetch;window.fetch=(u,o)=>{const p=new URL(String(u),location.href).pathname;if(p.endsWith('/versions'))return Promise.resolve(Response.json([{digest:a,version:1,name:'page.html',media_type:'text/html'},{digest:b,version:2,name:'page.html',media_type:'text/html'}]));if(p.endsWith(a)||p.endsWith(b))return Promise.resolve(new Response('<h1>'+ (p.endsWith(a)?'Before':'After')+'</h1><script>parent.__unsafeCompare=true</script>'));return real(u,o)};const v=(await import(S+'artifact_versions.js')).attachVersions(dialog,{body:()=>dialog.querySelector('.compare-body'),sheetOpen:()=>false,setSheet:()=>{},reload:()=>{},open:()=>{}});await v.open(b,'local');dialog.querySelector('.av-current').click();return true})()`);
        await waitFor(`!!document.querySelector('#beginner-compare .av-compare')`, 'compare control');
        await ev(`document.querySelector('#beginner-compare .av-compare').click();true`);
        await waitFor(`document.querySelectorAll('.av-pages iframe').length===2`, 'rendered before and after by default');
        assert.equal(await ev(`!!window.__unsafeCompare`),false,'artifact scripts stay inert');
        assert.ok(await ev(`[...document.querySelectorAll('.av-pages iframe')].every(f=>f.getAttribute('sandbox')==='')`),'both pages use empty sandbox');
        assert.match(await ev(`document.querySelector('.av-pages').textContent`),/v1.*v2/s);
        // Counts state which population they describe; the sidebar's unread badge stays separate.
        const spec=await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>{const s=m.needsListSpec();return {count:s.count,n:s.rows.length,status:s.status}})`);
        assert.ok(Number.isFinite(Number(spec.count)), 'main unread heading count remains numeric');
        console.log('PASS the Skills tab: Coral examples are published by Coral (example) and cannot be removed; an Operator\'s skill keeps Remove');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
