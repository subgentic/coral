const { ROWS, SETUP } = require('../resize_case_setup');
module.exports = `${SETUP}
        window.fetch = (u,o) => new URL(String(u),location.origin).pathname === '/api/activity' ? json({ actions: [1,2].map(n=>({id:n,action:'reply',item_kind:'ask',title:'Release question '+n,team:'team-a',source:'local',at:'2026-11-01T00:00:00Z'})) }) : real(u,o);
        const m = await import(S + 'inbox_activity.js'); await m.refresh(); document.body.replaceChildren(host); host.append(m.spec({}, {file(){},goal(){}}).node());`;
