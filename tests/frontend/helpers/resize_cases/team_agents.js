const { ROWS, SETUP } = require('../resize_case_setup');
module.exports = `${SETUP}
        window.fetch = (u,o) => { const p = new URL(String(u),location.origin).pathname; if (p === '/api/board/team-a/status') return json({agents:[1,2].map(n=>({name:'Agent '+n,subscriber_id:'Agent '+n,availability:'available',agent_type:'claude'}))}); if (p === '/api/teams/detail/team-a') return json({members:[]}); return real(u,o); };
        const m = await import(S + 'team_agents_page.js'); await m.showAgents(host,'team-a'); document.body.replaceChildren(host);`;
