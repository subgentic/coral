// An agent's name opens its chat everywhere it is shown (#12168, #12182), the Needs you rows and the question view here: the uploader of a file for review and the asker of a question are the shared link when
// that agent is running (a button that opens its chat and not the row's own page) and plain text with a tooltip when it is gone; the case is as written. Review row, question row, stubbed in the page. 1280 and 390.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const team = 'names-' + Date.now().toString(36), S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(async () => { const st = await import(${S} + 'state.js'); st.state.liveSessions = [{ session_id: 'sess-pw', name: 'pw-agent', agent_type: 'claude', board_subscriber_id: 'Plan Writer', board_project: '${team}' }]; window.__opened = null; window.selectLiveSession = (...a) => { window.__opened = a; };
                const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })); const hex = n => n.toString(16).padStart(64, '0');
                const items = [{ id: hex(1), name: 'plan-1.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Plan Writer', review_question: 'Ship it?' }];
                window.__asks = [{ board: '${team}', kind: 'ask', id: 71, asker: 'Orchestrator', text: '@Operator Which port should the test server use?', at: new Date(Date.now() - 120000).toISOString() }];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (String(url) === '/api/operator-asks') return json(window.__asks);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); }; return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 2`, at + 'the two rows', 15000);
            await ev(framesJs(4));
            const m = await ev(`(() => { const row = n => [...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes(n)), r1 = row('plan-1.md'), r2 = row('Which port'), f1 = r1.querySelector('.inbox-review-from'), f2 = r2.querySelector('.inbox-review-from'); return { f1: { tag: f1.tagName, text: f1.textContent.trim(), cls: f1.className }, f2: { tag: f2.tagName, text: f2.textContent.trim(), title: f2.title } }; })()`);
            check(m.f1.tag === 'BUTTON' && m.f1.text === 'Plan Writer' && /agent-link/.test(m.f1.cls), at + 'a running uploader is the shared link, as written: ' + JSON.stringify(m.f1));
            check(m.f2.tag === 'SPAN' && m.f2.text === 'Orchestrator' && /not running/.test(m.f2.title), at + 'an asker that is gone is plain text with a tooltip: ' + JSON.stringify(m.f2));
            await ev(`document.querySelector('${T} .inbox-review-from.agent-link').click(); true`); await ev(framesJs(3));
            check(JSON.stringify(await ev('window.__opened && window.__opened.slice(0, 3)')) === JSON.stringify(['pw-agent', 'claude', 'sess-pw']), at + 'the name opens that agent\'s chat');
            check(!(await ev(`!!document.querySelector('#artifact-viewer[open], #artifact-viewer:not([hidden])') && !!document.querySelector('.artifact-viewer-title')?.textContent`)), at + 'and does not also open the file');
            // a name clicked inside a dialog with typed words asks before it closes the dialog and drops them (#12299); an empty box does not ask
            await ev(`(async () => { const L = await import(${S} + 'agent_link.js'); const d = document.createElement('dialog'); d.id = 'draft-dlg'; const t = document.createElement('textarea'); t.id = 'draft-box'; d.append(t, L.agentLink('Plan Writer', {})); document.body.append(d); d.showModal(); window.__opened = null; t.value = 'half a reply'; d.querySelector('.agent-link').click(); return true; })()`); await ev(framesJs(3));
            const ask = await ev(`(() => { const y = document.querySelector('.agent-leave-ask [data-agent-leave-yes]'), r = y && y.getBoundingClientRect(), top = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { opened: !!window.__opened, dlgOpen: !!document.querySelector('#draft-dlg[open]'), kept: document.getElementById('draft-box')?.value, asked: !!y, reachable: !!y && (top === y || y.contains(top)), label: y?.textContent }; })()`);
            check(!ask.opened && ask.dlgOpen && ask.kept === 'half a reply' && ask.asked && ask.reachable && ask.label === 'Open chat', at + 'with words typed in a native modal dialog the click asks first, the question is in front (its button is what a tap reaches) and nothing changed: ' + JSON.stringify(ask));
            await ev(`(() => { const r = document.querySelector('.agent-leave-ask [data-agent-leave-yes]').getBoundingClientRect(); document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).click(); return true; })()`); await ev(framesJs(3));
            check((await ev('!!window.__opened')) && !(await ev(`!!document.querySelector('#draft-dlg[open], .agent-leave-ask')`)), at + 'confirmed by a real hit on the button: the chat opens and both dialogs are gone');
            await ev(`document.getElementById('draft-dlg')?.remove(); true`);
            // the people circles and names of every table (#12197): a running agent's circle and name open its chat, a gone one is left alone; a name built as markup is escaped
            const tb = await ev(`(async () => { const DT = await import(${S} + 'data_table.js'), L = await import(${S} + 'agent_live.js'); window.__opened = null;
                const host = document.createElement('div'); host.id = 'zz-people'; host.append(DT.avatar('Plan Writer'), DT.avatars([{ name: 'Plan Writer' }, { name: 'Gone Agent', review: true }], 'Done by Plan Writer, reviewed by Gone Agent'), DT.avatar('Gone Agent')); document.body.append(host);
                const circles = [...host.querySelectorAll('.dt-avatar')].map(c => c.dataset.agentLink || ''), nm = host.querySelector('.dt-person-name');
                const html = L.agentNameHtml('Plan <b>Writer</b>', { board: '${team}' }), gone = L.agentNameHtml('Gone <i>Agent</i>');
                nm.click(); const first = window.__opened && window.__opened[2]; window.__opened = null; host.querySelector('.dt-avatar').click(); const second = window.__opened && window.__opened[2];
                return { circles, first, second, goneHtml: gone, html }; })()`);
            check(JSON.stringify(tb.circles) === JSON.stringify(['sess-pw', 'sess-pw', '', '']), at + 'a running agent\'s circles carry the link, a gone one\'s do not: ' + JSON.stringify(tb.circles));
            check(tb.first === 'sess-pw' && tb.second === 'sess-pw', at + 'the name and the circle in a table open its chat: ' + JSON.stringify([tb.first, tb.second]));
            check(/&lt;i&gt;Agent&lt;\/i&gt;/.test(tb.goneHtml) && !/<i>/.test(tb.goneHtml) && !/data-agent-link/.test(tb.goneHtml), at + 'a name built as markup is escaped, and a gone one is not a link: ' + tb.goneHtml);
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('agent_name_link_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
