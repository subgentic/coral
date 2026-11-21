// #20203: a sole Dismiss is a direct footer action; real multi-item menus retain refresh/focus guards. The earlier phone Inbox row's ⋯ menu (#137104): a Needs you row for a wait the Operator may dismiss (a permission, a question or a plan) has a 44 px ⋯ button at its right that opens the one menu, whose first action is
// Dismiss (Lead's dismiss-wait route, #11352); the row stays one line at 56 px, the button is the row's own control (a press never opens the row), it has a name, opens with a tap or the keyboard, and Escape gives the
// focus back to it. Every waiting row has a ⋯ (a sign-in's holds Dismiss, #11946), and a desktop keeps its table and its Dismiss button. 390 and 360 px with touch, light and dark; isolated dev server, the Inbox's census world.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { axName } = require('./helpers/ax_tree');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const iso = ms => new Date(Date.now() - ms).toISOString();
const AGENTS = [
    { name: 'ag-one', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent One', working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./pkg/...', waiting_since: iso(300000), board_project: 'team-a', sleeping: false },
    { name: 'ag-two', session_id: '00000002-0000-4000-8000-000000000002', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent Two', working_directory: '/repo/b', waiting_for_input: true, waiting_kind: 'question', waiting_since: iso(120000), board_project: 'team-b', sleeping: false },
    { name: 'ag-three', session_id: '00000003-0000-4000-8000-000000000003', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent Three', working_directory: '/repo/c', waiting_for_input: true, waiting_kind: 'login', waiting_since: iso(60000), board_project: 'team-c', sleeping: false },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const failures = [];
    const check = (name, ok, detail) => { if (ok) console.log('PASS ' + name); else { failures.push(name); console.log('FAIL ' + name + (detail ? ' - ' + detail : '')); } };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 300)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const key = async (k, code, vk) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k === 'Enter' ? { text: '\r' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    const T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` }); // the Inbox's list is read before a test can set its order: oldest first, set before the page loads (newest first is the default, #11552)
        for (const [w, h, mobile] of [[390, 844, true], [360, 780, true], [1280, 820, false]]) for (const theme of ['dark', 'light']) {
            const at = `${w}px ${theme}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await setTheme(ev, theme);
            await ev(INBOX_WORLD);
            await ev(`(() => { window.__dismissed = []; const real = window.fetch; window.fetch = (u, o = {}) => { const p = String(u); if (/\\/dismiss-wait$/.test(p)) { window.__dismissed.push({ url: p, body: JSON.parse(o.body || '{}') }); return Promise.resolve(new Response(JSON.stringify({ dismissed: true }), { status: 200, headers: { 'content-type': 'application/json' } })); } return real(u, o); }; return true; })()`);
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(AGENTS)}; window.__inboxTab = m; window.__state = state; m.updateInboxTab(); return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .dt-table tbody tr').length === 3 && document.querySelector('${T}').getClientRects().length > 0`, at + 'the three waiting agents', 10000);
            // The list redraws four times in the first ~25 ms after its rows appear (late data), and a tap in that burst lands on a row that is then replaced (#14630): wait until it has been still for 300 ms.
            await ev(`window.__rowChange = performance.now(); new MutationObserver(() => { window.__rowChange = performance.now(); }).observe(document.querySelector('${T}'), { childList: true, subtree: true }); true`);
            await waitFor(`performance.now() - window.__rowChange >= 300`, at + 'the list is still', 6000);
            if (!mobile) {
                await waitFor(`document.querySelectorAll('${T} .inbox-single-action .inbox-dismiss').length === 3`,at+'desktop single Dismiss actions');
                check(at+'a desktop exposes each sole Dismiss directly',true);
                await ev(`(async()=>{const S=window.__coralStatic||'/static/',DT=await import(S+'data_table.js'),G=await import(S+'sidebar_groups.js'),M=await import(S+'menu_button.js');window.__refreshRows=[{id:'same-row',waiting_since:'old'}];window.__chosen=[];const node=()=>DT.dataTable({label:'Refresh menu',rows:window.__refreshRows,rowKey:r=>r.id,columns:[{key:'name',label:'Agent',primary:true,cell:r=>r.id},{key:'action',label:'Actions',cell:r=>{const wrap=document.createElement('span'),t=document.createElement('button'),m=document.createElement('div');t.textContent='More';t.className='refresh-test-toggle';t.setAttribute('aria-haspopup','menu');t.setAttribute('aria-expanded','false');t.setAttribute('aria-controls','refresh-test-menu');m.id='refresh-test-menu';m.className='menu';m.hidden=true;for(const label of (r.actions||['First','Second'])){const b=document.createElement('button');b.textContent=label;b.setAttribute('role','menuitem');b.addEventListener('click',()=>window.__chosen.push(r.waiting_since+label));m.append(b)}t.addEventListener('click',()=>M.toggleMenu(t));wrap.append(t,m);return wrap}}],state:DT.tableState()}).el;G.registerGroupSource('refresh-menu-test',{keys:()=>['needs','other'],table:()=>({title:'Needs you refresh fixture',rows:window.__refreshRows,node,signature:JSON.stringify(window.__refreshRows)})});G.openGroupTable('refresh-menu-test','needs');window.__redrawMenu=()=>G.refreshGroupTable('refresh-menu-test');window.__renderMenuNode=node;document.querySelector('.refresh-test-toggle').click();return true})()`);
                await waitFor(`document.querySelector('.refresh-test-toggle')?.getAttribute('aria-expanded')==='true'`,at+'desktop table menu open');
                await ev(`document.querySelectorAll('#refresh-test-menu [role=menuitem]')[1].focus();window.__oldDesktopToggle=document.querySelector('.refresh-test-toggle');window.__refreshRows=[{id:'same-row',waiting_since:'new'}];window.__redrawMenu();true`);
                await waitFor(`!window.__oldDesktopToggle.isConnected&&document.querySelector('.refresh-test-toggle')?.getAttribute('aria-expanded')==='true'`,at+'desktop refresh restores same-row menu');
                assert.equal(await ev(`document.activeElement?.textContent`),'Second',at+'same action keeps keyboard focus');
                await key('Enter','Enter',13);
                assert.deepEqual(await ev('window.__chosen'),['newSecond'],at+'the refreshed action uses the new row data');
                await ev(`document.querySelector('.refresh-test-toggle').click();document.querySelectorAll('#refresh-test-menu [role=menuitem]')[1].focus();window.__oldDesktopToggle=document.querySelector('.refresh-test-toggle');window.__refreshRows=[{id:'same-row',waiting_since:'removed-action',actions:['First']}];window.__redrawMenu();true`);
                await waitFor(`!window.__oldDesktopToggle.isConnected&&document.querySelector('.refresh-test-toggle')?.getAttribute('aria-expanded')==='true'`,at+'refresh removes the focused action');
                assert.equal(await ev(`document.activeElement===document.querySelector('.refresh-test-toggle')`),true,at+'removed focused action returns focus to toggle, never another action');
                await key('Enter','Enter',13);
                assert.deepEqual(await ev('window.__chosen'),['newSecond'],at+'Enter on fallback toggle does not execute a different action');
                await ev(`document.querySelector('.refresh-test-toggle').click();window.__oldFolderMenu=document.getElementById('refresh-test-menu');window.__folderScope=document.getElementById('group-table-view');window.__folderScope.dataset.group='refresh-menu-test:other';window.__folderScope.replaceChildren(window.__renderMenuNode());true`);
                await waitFor(`document.querySelector('#group-table-view').dataset.group==='refresh-menu-test:other'&&document.querySelector('.refresh-test-toggle')?.getAttribute('aria-expanded')==='false'`,at+'folder change closes rather than restoring same-key row menu');
                assert.equal(await ev(`document.getElementById('refresh-test-menu').hidden&&document.getElementById('group-table-view')===window.__folderScope&&document.querySelector('#group-table-view tr[data-key]').dataset.key==='same-row'`),true,at+'same scope and row key in new folder have no open menu');
                await ev(`document.querySelector('.refresh-test-toggle').click();window.__refreshRows=[];window.__redrawMenu();true`);
                await waitFor(`!document.getElementById('refresh-test-menu')||document.getElementById('refresh-test-menu').hidden`,at+'removed row does not leave an orphan menu');
                continue;
            }
            const rows = await ev(`[...document.querySelectorAll('${T} tr.dt-mailed')].map(tr => { const b=tr.querySelector('.inbox-single-action .inbox-dismiss'),r=b?.getBoundingClientRect(),box=tr.getBoundingClientRect(),title=tr.querySelector('.dt-mail-title');return{title:title.textContent,w:r?.width,h:r?.height,name:b?.getAttribute('aria-label'),popup:b?.getAttribute('aria-haspopup'),inside:!!b&&!b.closest('.dt-mail-open'),below:!!r&&r.top>=title.getBoundingClientRect().bottom,menu:!!tr.querySelector('.inbox-row-more-toggle'),answers:tr.querySelectorAll('.inbox-answer').length};})`);
            check(at+'every waiting row exposes a named 44 px Dismiss in its footer, outside the row opener',rows.length===3&&rows.every(r=>r.w>=44&&r.h>=44&&r.inside&&r.below&&!r.popup&&!r.menu&&/^Dismiss: Agent/.test(r.name)),JSON.stringify(rows));
            check(at+'sign-in has Dismiss without an answer control',rows.find(r=>r.title==='Agent Three')?.answers===0);
            check(at+'no sideways scroll',await ev(`document.documentElement.scrollWidth<=document.documentElement.clientWidth`));
            const probeKey=await ev(`document.querySelector('${T} tr.dt-mailed').dataset.key`),probe=`[...document.querySelectorAll('${T} tr.dt-mailed')].find(r=>r.dataset.key===${JSON.stringify(probeKey)})?.querySelector('.inbox-single-action .inbox-dismiss')`;
            const url0=await ev('location.href');
            const ax=await axName(client,`${T} tr.dt-mailed .inbox-single-action .inbox-dismiss`);
            check(at+'Dismiss is named in the accessibility tree',!!ax);
            // The direct action executes once even when its row is replaced immediately after the click.
            await ev(`(()=>{const b=(${probe});b.click();window.__state.liveSessions=window.__state.liveSessions.map(a=>({...a,waiting_since:new Date(Date.parse(a.waiting_since)-1000).toISOString()}));window.__inboxTab.updateInboxTab();return true;})()`);
            await waitFor('window.__dismissed.length===1',at+'one direct Dismiss request despite redraw',6000);
            const sent=await ev('window.__dismissed[0]');
            check(at+'Dismiss targets only Agent One',/\/api\/sessions\/live\/ag-one\/dismiss-wait$/.test(sent.url)&&sent.body.session_id===AGENTS[0].session_id,JSON.stringify(sent));
            check(at+'Dismiss never opens the agent',await ev('location.href')===url0);
            await ev(`window.__state.liveSessions=${JSON.stringify([AGENTS[1]])};window.__inboxTab.updateInboxTab();true`);
            await waitFor(`!![...document.querySelectorAll('${T} tbody tr[data-key]')].find(r=>r.textContent.includes('Agent Two'))?.querySelector('.inbox-single-action .inbox-dismiss')`,at+'second agent action');
            await ev(`[...document.querySelectorAll('${T} tbody tr[data-key]')].find(r=>r.textContent.includes('Agent Two')).querySelector('.inbox-single-action .inbox-dismiss').focus();true`);
            await key('Enter','Enter',13);await waitFor('window.__dismissed.length===2',at+'keyboard Dismiss request',6000);
            check(at+'keyboard Dismiss targets Agent Two once',await ev(`window.__dismissed[1].body.session_id===${JSON.stringify(AGENTS[1].session_id)}`));
            await shot(`inbox-row-dismiss-${w}-${theme}`);

        }
    } catch (e) { console.log('ERROR ' + (e.stack || e)); failures.push('error'); }
    await client.close();
    if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
    console.log('inbox_row_menu_browser: all ok');
})();
