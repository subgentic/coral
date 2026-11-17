// #16419: the real Settings switch removes team grouping, including nested cards, and folder actions match the flat list.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const S = (id, team, extra = {}) => ({session_id:id,name:'repo',agent_type:'claude',working_directory:'/tmp/repo',display_name:id,sleeping:false,...(team ? {board_project:team} : {}),...extra});
const SESSIONS = [S('Team A lead','team-a'),S('Team A dev','team-a',{display_name:'Needle'}),S('Team B dev','team-b'),S('Solo',''),S('Archived','',{archived:true}),S('Remote','',{server:'qa-remote-1'}),S('Other','',{name:'other',working_directory:'/tmp/other'})];
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const list = '#live-sessions-list';
    const ids = () => ev(`[...document.querySelectorAll('${list} > li.session-group-item')].map(r=>r.dataset.sessionId)`);
    const setGrouping = async on => {
        await ev(`window.showSettingsModal('general')`);
        await waitFor(`!!document.querySelector('#settings-group-by-team')`, 'the grouping setting', 8000);
        await ev(`(() => { const c=document.querySelector('#settings-group-by-team'); if(c.checked !== ${on})c.click(); window.hideSettingsModal(); })()`);
        await waitFor(`localStorage.getItem('coral-group-by-team') === '${on}'`, 'saved grouping setting', 3000);
    };
    const stopCount = async (count, teamCount) => {
        await ev(`document.querySelector('${list} [data-on-click="group-kill"][data-group="repo"]').click(); true`);
        await waitFor(`getComputedStyle(document.querySelector('#confirm-modal')).display !== 'none'`, 'Stop all confirmation', 5000);
        assert.match(await ev(`document.querySelector('#confirm-modal-message').textContent`),new RegExp(count === 1 ? 'Stop the 1 agent' : 'Stop all '+count+' agents'), 'confirmation counts the shown folder members');
        const message = await ev(`document.querySelector('#confirm-modal-message').textContent`);
        if (teamCount) assert.ok(message.includes(`including ${teamCount} team ${teamCount === 1 ? 'member' : 'members'}`),'confirmation names the included team members');
        else assert.ok(!message.includes('including'),'standalone-only confirmation has no team-member note');
        await ev(`document.querySelector('#confirm-modal [data-on-click="m-hide-confirm-modal"]').click(); true`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
        await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { localStorage.removeItem('coral_collapsed_groups'); localStorage.setItem('coral-group-by-team','true');
            window.__m.agents={}; for(const s of ${JSON.stringify(SESSIONS)})window.__m.add(s.name,'S',5,s);
            window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); })()`);
        await waitFor(`document.querySelectorAll('${list} .session-team-group').length === 2`, 'team grouping on', 5000);
        await setGrouping(false);
        assert.equal(await ev(`document.querySelectorAll('${list} .session-team-group').length`),0,'off means no team cards, including inside a folder');
        assert.equal(await ev(`document.querySelectorAll('${list} .board-card-header').length`),0,'no team/workflow subgroup header remains');
        const localIds = await ids();
        for(const id of ['Team A lead','Team A dev','Team B dev','Solo'])assert.ok(localIds.includes(id),id+' is a direct agent row');
        assert.equal(await ev(`document.querySelector('${list} > .session-group-header[data-group-name="repo"] .session-group-count').textContent`),'4','folder counts all four local awake agents');
        await stopCount(4,3); // Cancel: no agent is stopped by this test.
        await ev(`document.querySelector('${list} > .session-group-header[data-group-name="repo"]').click(); true`);
        assert.ok(!(await ids()).includes('Team A lead'),'folder collapse hides its team members too');
        await ev(`document.querySelector('${list} > .session-group-header[data-group-name="repo"]').click(); true`);
        assert.ok((await ids()).includes('Team A lead'),'expanding restores them');
        await ev(`window.filterLiveAgents('Needle'); true`);
        await stopCount(1,1);
        await ev(`window.filterLiveAgents(''); true`);
        await setGrouping(true);
        await waitFor(`document.querySelectorAll('${list} .session-team-group').length === 2`, 'team cards return', 5000);
        await stopCount(1,0); // Grouped teams retain their own actions; the folder contains only Solo.
        assert.ok((await ids()).includes('Solo'),'standalone agent stays in its folder');
        console.log('PASS real group-by-team setting: flat folders when off, team cards when on, collapse/search and Stop all counts agree');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
