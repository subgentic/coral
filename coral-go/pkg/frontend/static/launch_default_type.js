/* The agent type New agent starts on (#596): the default_agent_type setting; else the type of the newest agent on the computer the launch is for;
 * else Claude, which the provider cards (launch_provider_cards.js) move to the first installed agent when Claude is missing and nothing was chosen.
 * A plain terminal is not an agent type to start on. */
const ALIAS = { gemini: 'agy', antigravity: 'agy' };
const norm = t => { const v = String(t || '').trim().toLowerCase(); return ALIAS[v] || v; };
const when = s => { const t = Date.parse(s && s.created_at); return Number.isFinite(t) ? t : -Infinity; };

/** setting: that computer's default_agent_type; sessions: the live list; server: the computer, 'local' for this one. */
export function startingAgentType(setting, sessions, server) {
    const set = norm(setting);
    if (set) return set;
    const srv = server || 'local';
    let newest = null;
    for (const s of sessions || []) {
        if (!s || (s.server || 'local') !== srv) continue;
        const t = norm(s.agent_type);
        if (!t || t === 'terminal') continue;
        if (!newest || when(s) > when(newest)) newest = s;
    }
    return newest ? norm(newest.agent_type) : 'claude';
}
