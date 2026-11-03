const { SETUP } = require('../resize_case_setup');
module.exports = `${SETUP}
    window.fetch = (u,o) => { const p = new URL(String(u),location.origin).pathname; if (p === '/api/board/team-a/goals') return json({goals:[1,2].map(n=>({id:n,title:'Release goal '+n,state:'active',rollup:{total:3,done:n},updated_at:'2026-11-01T00:00:00Z'}))}); if (p === '/api/board/team-a/settings') return json({require_goal:false}); return real(u,o); };
    const m = await import(S + 'goals_view.js'); m.showGoals(host,'team-a'); document.body.replaceChildren(host);`;
