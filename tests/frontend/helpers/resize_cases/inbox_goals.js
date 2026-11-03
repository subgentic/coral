const { SETUP } = require('../resize_case_setup');
const { INBOX_WORLD } = require('../inbox_world');
module.exports = { selector: '#group-table-view', setup: `${SETUP} ${INBOX_WORLD}; host.remove();
    const previous = window.fetch; window.fetch = (u,o) => new URL(String(u),location.origin).pathname === '/api/goals' ? json({goals:[1,2].map(n=>({id:n,board_id:'team-a',title:'Release goal '+n,state:'active',rollup:{total:3,done:n},updated_at:'2026-11-01T00:00:00Z'}))}) : previous(u,o);
    window.switchNavTab('hub-inbox'); await (await import(S + 'inbox_tab.js')).selectInboxTab('goals');` };
