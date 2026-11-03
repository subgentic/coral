const { SETUP } = require('../resize_case_setup');
module.exports = `${SETUP}
    const m = await import(S + 'registered_server_view.js'); await m.serverView.mount(host,()=>{}); m.serverView.accept([1,2].map(n=>({id:'srv'+n,label:'Computer '+n,status:'online',agent_count:n,version:'2.0.39',last_seen:'2026-11-01T00:00:00Z'}))); m.serverView.render(); document.body.replaceChildren(host);`;
