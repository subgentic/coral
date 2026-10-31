// Send to agent: the picker inside a comment card, and what came of the ask (split out of attachComments, #8376).
import { importOnce } from './import_once.js';
import { scrollBehavior } from './motion.js';
import { decisionNeedsPerson } from './server_base.js';
const api = await importOnce('./artifact_comments_api.js');
const askUi = await importOnce('./artifact_comment_send.js');

/** The ask state and actions of one comments panel: `st` is the panel's state (`st.ask` is the open picker), the rest are its draw and announce hooks. */
export function createAsk({ st, panel, render, announce, refresh, ownHex }) {
    const askedBy = new Map(); // comment id -> Map(agent role, lowercase -> words): who was asked into a thread from this panel (the server refuses a second ask of an open one, and says so)
    const canAsk = (c) => !decisionNeedsPerson(st.server) && !!st.board && !!st.data?.canLock && !c.deleted && !c.resolved && c.parentId == null;
    const askedOf = (id) => askedBy.get(id) || (askedBy.set(id, new Map()), askedBy.get(id));
    // Who is asked into this thread: what the server's list says (an ask that is still open, with how many times the agent has replied: it survives a reload) and what this page sent since (the newest words).
    function askedNow(id) {
        const m = new Map();
        const c = st.data && st.data.comments.find(x => x.id === id);
        for (const k of (c && c.asks) || []) if (k.open && k.agent) m.set(k.agent.toLowerCase(), askUi.askedWords(k));
        for (const [role, words] of askedOf(id)) m.set(role, words);
        return m;
    }
    function askBlock() {
        const k = st.ask;
        return askUi.buildSendBlock({ id: k.id, board: st.board, agents: k.agents, picked: k.picked, asked: askedNow(k.id), results: k.results, busy: k.busy, error: k.error,
            onToggle: (role) => { if (k.picked.has(role)) k.picked.delete(role); else if (k.picked.size < askUi.MAX_AGENTS) k.picked.add(role); redrawAsk(role); },
            onCancel: () => { st.ask = null; render(); panel.querySelector(`.ac-card[data-id="${k.id}"] .ac-ask-open`)?.focus(); },
            onSend: () => sendAsk() });
    }
    // The block is drawn again in place (not the whole panel), so a checkbox keeps its focus while it is ticked.
    function redrawAsk(focusRole) {
        const old = panel.querySelector('.ac-ask'); if (!old || !st.ask) return;
        old.replaceWith(askBlock());
        if (focusRole) [...panel.querySelectorAll('.ac-ask input[type="checkbox"]')].find(i => i.value === focusRole)?.focus();
    }
    async function openAsk(c) {
        const k = st.ask = { id: c.id, hex: ownHex(c), agents: null, picked: new Set(), results: null, busy: false, error: '' };
        render();
        panel.querySelector('.ac-ask')?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
        try {
            const { refreshTeamAvailability } = await importOnce('./team_availability.js');
            const data = await refreshTeamAvailability(st.board, true);
            if (st.ask !== k) return;
            k.agents = askUi.pickableAgents(data && data.agents);
        } catch { if (st.ask !== k) return; k.agents = 'error'; }
        redrawAsk();
        panel.querySelector('.ac-ask input[type="checkbox"]:not(:disabled)')?.focus();
    }
    async function sendAsk() {
        const k = st.ask; if (!k || k.busy || !k.picked.size) return;
        k.busy = true; k.error = ''; redrawAsk();
        const hex = st.hex;
        let res;
        try { res = await api.sendComment(k.hex || hex, st.server, k.id, [...k.picked]); } catch { res = { ok: false, status: 0, results: [], error: 'Coral could not be reached.' }; }
        if (st.ask !== k) return;
        k.busy = false;
        if (res.results.length) {
            k.results = res.results;
            const asked = askedOf(k.id);
            for (const r of res.results) if (r.state === 'sent' || r.state === 'already_asked') asked.set(r.agent.toLowerCase(), r.state === 'sent' ? 'Asked just now' : 'Already asked');
            const n = res.results.filter(r => r.state === 'sent').length;
            announce(n ? `Asked ${n} agent${n === 1 ? '' : 's'}. Their replies come into this thread.` : 'Nobody was asked.');
            if (n) for (const ms of [10000, 30000, 90000]) setTimeout(() => { if (hex === st.hex) refresh(); }, ms); // the agents' replies are replies in the thread: fetched a few times while they work
        } else { k.error = res.error || 'The comment was not sent.'; }
        redrawAsk();
        panel.querySelector('.ac-ask .ac-cancel')?.focus();
    }
    return { canAsk, openAsk, askBlock };
}
