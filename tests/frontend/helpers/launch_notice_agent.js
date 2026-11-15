// A notice geometry test needs a local agent after #16595. The agent is inert fixture data.
exports.PRELOAD = `(() => { const real = window.fetch; window.fetch = (input, options) => {
 const p = new URL(String(input && input.url || input), location.href).pathname;
 if (p === '/api/sessions/live' && (!options || !options.method || options.method === 'GET')) return Promise.resolve(Response.json({sessions:[{session_id:'notice-fixture',name:'Notice fixture',agent_type:'claude',server:'local',status:'idle',sleeping:false}],servers:[]}));
 return real(input, options);
}; })();`;
