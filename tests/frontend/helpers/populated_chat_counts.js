// Navigation tests need populated folders: #17453 hides empty chat folders.
// Keep history/list responses real; only seed the independent counts read.
const POPULATED_CHAT_COUNTS = `(() => { const real = window.fetch; window.fetch = (u, o) => {
    const url = new URL(String(u && u.url || u), location.href);
    if (url.pathname === '/api/sessions/history/counts') return Promise.resolve(new Response(JSON.stringify({ all: 4, group: 1, notes: 1, starred: 1, active: 1, archived: 1, by_agent_type: { claude: 1, codex: 1, agy: 1, pi: 1 }, tags: [] }), { headers: { 'content-type': 'application/json' } }));
    return real(u, o);
}; return true; })()`;
module.exports = { POPULATED_CHAT_COUNTS };
