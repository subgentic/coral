const { SETUP } = require('../resize_case_setup');
const { INBOX_WORLD } = require('../inbox_world');
module.exports = { selector: '#group-table-view', setup: `${SETUP} ${INBOX_WORLD}; host.remove();
    const {state} = await import(S+'state.js'); state.liveSessions=[1,2].map(n=>({name:'Agent '+n,session_id:'agent-'+n,agent_type:'claude',server:'local',status:'idle',display_name:'Agent '+n,working_directory:'/repo/project-'+n,waiting_for_input:true,waiting_kind:'permission',waiting_since:'2026-11-01T00:00:00Z'})); const m=await import(S+'inbox_tab.js');m.updateInboxTab();window.switchNavTab('hub-inbox');await m.selectInboxTab('needs');` };
