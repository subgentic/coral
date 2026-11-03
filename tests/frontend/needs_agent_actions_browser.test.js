// #12701: a waiting Codex row arrives before its name/summary and chat response.
// At 1280 its Item stays readable while asynchronously populated actions stay in Actions.
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    const check = (ok, text) => { if (!ok) failures.push(text); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(INBOX_WORLD);
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => {
            if (new URL(String(u), location.origin).pathname.endsWith('/delayed-codex/chat')) return new Promise(resolve => { window.__releaseChat = () => resolve(new Response(JSON.stringify({ messages: [], prompt_options: { options: [] } }), { headers: { 'Content-Type': 'application/json' } })); });
            return real(u, o);
        }; return true; })()`);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); window.__waiting = { name: 'delayed-codex', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'codex', server: 'local', status: 'idle', working_directory: '/repo/coral-go', waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date().toISOString() }; state.liveSessions = [window.__waiting]; (await import(${S} + 'inbox_tab.js')).updateInboxTab(); window.switchNavTab('hub-inbox'); await (await import(${S} + 'inbox_tab.js')).selectInboxTab('needs'); return true; })()`);
        await waitFor(`!!window.__releaseChat && !!document.querySelector('${T} tbody tr td[data-key=agent]')`, 'waiting row before chat');
        const inspect = async stage => {
            await ev(framesJs(8));
            const r = await ev(`(() => { const table = document.querySelector('${T} table'), row = table.querySelector('tbody tr'), item = row.querySelector('td[data-key=agent]'), actions = row.querySelector('td[data-key=review]'), head = table.querySelector('th[data-key=agent]'), ah = table.querySelector('th[data-key=review]'), box = table.getBoundingClientRect();
                return { header: head.querySelector('.dt-sort > span, .dt-head-text')?.textContent.trim(), item: item.innerText, itemWidth: item.getBoundingClientRect().width, actionsHeader: ah?.querySelector('.dt-sort > span, .dt-head-text')?.textContent.trim(), wrong: [...row.querySelectorAll('.inbox-open-agent, .inbox-dismiss')].some(b => b.closest('td') !== actions), fits: table.scrollWidth <= table.clientWidth + 1 && box.right <= document.querySelector('${T}').getBoundingClientRect().right + 1 }; })()`);
            check(r.header === 'Item' && r.actionsHeader === 'Actions', stage + ': visible Item and Actions headers: ' + JSON.stringify(r));
            check(r.itemWidth >= 120 && /coral-go|Frontend Dev/.test(r.item) && !r.wrong && r.fits, stage + ': readable item and actions in their own column: ' + JSON.stringify(r));
            if (stage === 'before fields') check(/Waiting for details/.test(r.item), 'missing summary has a placeholder: ' + JSON.stringify(r));
        };
        await inspect('before fields');
        await ev(`window.__releaseChat(); true`);
        await waitFor(`!!document.querySelector('${T} .inbox-open-agent') && !!document.querySelector('${T} .inbox-dismiss')`, 'chat fallback actions');
        await inspect('after chat');
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.liveSessions = [{ ...window.__waiting, display_name: 'Frontend Dev', waiting_summary: 'Review the component' }]; (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
        await waitFor(`document.querySelector('${T} td[data-key=agent]')?.textContent.includes('Frontend Dev')`, 'fields arrive');
        await inspect('after fields');
        // #12740: agent rows also need the placeholder among questions and among proposals.
        await ev(`(() => { const real = window.fetch; window.__mixedAsks = []; window.__mixedProposals = []; window.fetch = (u, o) => { const path = new URL(String(u), location.origin).pathname, json = d => Promise.resolve(new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } })); if (path === '/api/operator-asks') return json(window.__mixedAsks); if (path === '/api/proposals') return json({ proposals: window.__mixedProposals }); return real(u, o); }; return true; })()`);
        for (const kind of ['question', 'proposal']) {
            await ev(`(async () => { window.__mixedAsks = ${kind === 'question' ? "[{ board: 'team-a', kind: 'ask', id: 41, asker: 'Orchestrator', text: 'Which port should we use?', at: new Date().toISOString() }]" : '[]'}; window.__mixedProposals = ${kind === 'proposal' ? "[{ id: 11, board_id: 'team-a', kind: 'goal', title: 'Ship the beta', proposer: 'Orchestrator', state: 'pending', created_at: new Date().toISOString(), payload: { title: 'Ship the beta', outcome: 'Release is out' } }]" : '[]'}; const { state } = await import(${S} + 'state.js'); state.liveSessions = [window.__waiting]; await (await import(${S} + 'operator_asks.js')).refreshOperatorAsks(true); await (await import(${S} + 'inbox_proposals.js')).refreshProposals(true); (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 2`, 'mixed ' + kind + ' table');
            await ev(framesJs(8));
            const mixed = await ev(`(() => { const row = document.querySelector('${T} tr[data-key="local:00000001-0000-4000-8000-000000000001"]'), item = row?.querySelector('td[data-key=agent]'), sub = item?.querySelector('.dt-subtitle'); return { item: item?.textContent, placeholder: sub?.textContent, shown: !!sub && sub.getClientRects().length > 0, rest: [...document.querySelectorAll('${T} tbody tr')].filter(r => r !== row).map(r => r.textContent).join(' ') }; })()`);
            check(mixed.shown && mixed.placeholder === 'Waiting for details…' && mixed.item.includes('coral-go'), 'missing summary in mixed ' + kind + ' table: ' + JSON.stringify(mixed));
            check(kind === 'question' ? mixed.rest.includes('Which port should we use?') : mixed.rest.includes('Ship the beta'), 'mixed item retains its own text: ' + JSON.stringify(mixed));
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.liveSessions = [{ ...window.__waiting, waiting_summary: 'Review the component' }]; (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await waitFor(`!document.querySelector('${T} tr[data-key="local:00000001-0000-4000-8000-000000000001"]').textContent.includes('Waiting for details…')`, 'arriving summary removes mixed placeholder');
        }

    } finally { await client.close(); }
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('needs_agent_actions_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
