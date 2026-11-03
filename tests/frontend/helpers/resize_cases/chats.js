const { SETUP } = require('../resize_case_setup');
module.exports = `${SETUP}
    window.fetch = (u,o) => new URL(String(u),location.origin).pathname === '/api/sessions/history' ? json({sessions:[1,2].map(n=>({session_id:'chat-'+n,title:'Release chat '+n,source_type:'claude',display_name:'Agent '+n,last_timestamp:'2026-11-01T00:00:00Z'})),total:2,page:1,page_size:200}) : real(u,o);
    const m = await import(S + 'mailbox_chats.js'); const draw = () => { const spec=m.chatsSpec('chats-active',{query:'',params:{},redraw:draw,after(){},open(){}}); if(spec?.node) host.replaceChildren(spec.node()); }; draw(); document.body.replaceChildren(host);`;
