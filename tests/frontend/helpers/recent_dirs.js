// The dialogs drop a recent folder the computer no longer has (pruneMissingRecents, #11336 item 9): a suite that seeds recent folders with made-up paths says so, and every folder list answers 200 for them.
// Call it after the page is loaded (a new page has the real fetch back).
const existing = ev => ev(`(() => { const R = window.fetch; window.fetch = (u, o) => { const p = new URL(String(u), location.href); return p.pathname === '/api/filesystem/list' && (o && o.cache) === 'no-store' ? Promise.resolve(new Response(JSON.stringify({ path: p.searchParams.get('path'), entries: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R(u, o); }; return true; })()`);
module.exports = { existing };
