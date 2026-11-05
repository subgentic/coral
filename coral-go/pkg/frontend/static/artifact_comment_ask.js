// Send to agent: the picker inside a comment card, and what came of the ask (split out of attachComments, #8376).
import { importOnce } from './import_once.js';
import { isSignedOut } from './overload.js';
import { scrollBehavior } from './motion.js';
import { decisionNeedsPerson, normServer, boardTeamKey } from './server_base.js';
import { state } from './state.js';
const api = await importOnce('./artifact_comments_api.js');
const askUi = await importOnce('./artifact_comment_send.js');
const { agentLink } = await importOnce('./agent_link.js');

/** The ask state and actions of one comments panel: `st` is the panel's state (`st.ask` is the open picker), the rest are its draw and announce hooks. */
export function createAsk({ st, panel, render, announce, refresh, ownHex }) {
    const askedBy = new Map(); // comment id -> Map(agent role, lowercase -> words): who was asked into a thread from this panel (the server refuses a second ask of an open one, and says so)
    const canAsk = (c) => !decisionNeedsPerson(st.server) && !!st.board && !!st.data?.canLock && !c.deleted && !c.resolved && c.parentId == null;
    /** Why Send to agent is not offered on this computer's file, when the reason is the missing Approve secret (#13230): `{ id, ssh }` for the computer, null when nothing is wrong. A person who comments on a file from a computer set up
     *  over SSH saw no Send to agent and no word why; the note says it and points at the Computers page, where an SSH computer has a button that sets it up. */
    const askSetup = () => {
        if (!st.board || !st.data?.canLock || !decisionNeedsPerson(st.server)) return null;
        const live = (state.servers || []).find(s => s && normServer(s.id) === normServer(st.server));
        return live ? { id: live.id, ssh: live.transport === 'ssh' } : null;
    };
    // A viewer lifetime owns its picker and transient status, even when the
    // next open uses the same computer, team and file.
    const resetAsk = () => { st.ask = null; askedBy.clear(); names.clear(); };
    const current = k => st.ask === k && st.lifetime === k.lifetime && st.hex === k.context.hex && st.server === k.context.server && st.board === k.context.board;
    const names = new Map(); // lower-cased role -> the role as written ("UX/UX Engineer"): the line under a comment shows it as written (#12168)
    const askedOf = (id) => askedBy.get(id) || (askedBy.set(id, new Map()), askedBy.get(id));
    // Who is asked into this thread: what the server's list says (an ask that is still open, with how many times the agent has replied: it survives a reload) and what this page sent since (the newest words).
    function askedNow(id) {
        const m = new Map();
        const c = st.data && st.data.comments.find(x => x.id === id);
        for (const k of (c && c.asks) || []) if (k.open && k.agent) { m.set(k.agent.toLowerCase(), askUi.askedWords(k)); names.set(k.agent.toLowerCase(), k.agent); }
        for (const [role, words] of askedOf(id)) m.set(role, words);
        return m;
    }
    /** The line under a comment that says whether an agent has it: at rest, and again as soon as a send answers (#12112: it kept saying "Not sent to an agent yet" beside "Asked just now"). */
    const fillStatus = (p, id) => { // each name as written and a button to the agent's chat (#12168)
        const asked = [...askedNow(id)]; p.replaceChildren();
        if (!asked.length) { p.textContent = 'Not sent to an agent yet'; return; }
        p.append('Sent to ');
        asked.forEach(([role, words], i) => { if (i) p.append(', '); p.append(agentLink(names.get(role) || role, { board: st.board }), ` (${words.replace(/^./, c => c.toLowerCase())})`); });
    };
    const statusWords = id => { const p = document.createElement('p'); fillStatus(p, id); return p.textContent; };
    const redrawStatus = id => { const p = panel.querySelector(`.ac-card[data-id="${id}"] .ac-ask-status`); if (p) fillStatus(p, id); };
    function askBlock() {
        const k = st.ask;
        return askUi.buildSendBlock({ id: k.id, board: st.board, agents: k.agents, empty: k.empty, picked: k.picked, asked: k.queue.length > 1 ? new Map() : askedNow(k.id), count: k.queue.length, results: k.results, busy: k.busy, error: k.error,
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
    async function openAsk(c, queue = [c]) {
        const k = st.ask = { queue: queue.map(c => ({ ...c, artifactId: ownHex(c) })), context: { hex: st.hex, server: st.server, board: st.board }, lifetime: st.lifetime, id: c.id, hex: ownHex(c), agents: null, picked: new Set(), results: null, busy: false, error: '' };
        render();
        panel.querySelector('.ac-ask')?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
        try {
            const { refreshTeamAvailability } = await importOnce('./team_availability.js');
            const data = await refreshTeamAvailability(boardTeamKey(k.context.server, k.context.board), true); // the team of the computer the FILE is on (#13687): a bare board id is asked of this computer, which has no such board for a remote computer's team
            if (!current(k)) return;
            k.agents = askUi.pickableAgents(data && data.agents);
            const named = normServer(k.context.server) === 'local' ? '' : String((state.servers || []).find(s => s.id === k.context.server)?.name || k.context.server);
            k.empty = askUi.emptyWords ? askUi.emptyWords(named, ((data && data.agents) || []).length, k.agents.length) : ''; // why it is empty, said on the picker (#13687)
        } catch { if (!current(k)) return; k.agents = 'error'; }
        redrawAsk();
        panel.querySelector('.ac-ask input[type="checkbox"]:not(:disabled)')?.focus();
    }
    async function sendAsk() {
        const k = st.ask; if (!k || !current(k) || k.busy || !k.picked.size) return;
        k.busy = true; k.error = ''; redrawAsk();
        const agents = [...k.picked];
        let res, sentThreads = 0;
        try {
            const { sendCommentQueue } = await importOnce('./artifact_comment_send_queue.js');
            const batch = await sendCommentQueue(k.queue, {
                isCurrent: () => current(k),
                send: c => api.sendComment(c.artifactId, k.context.server, c.id, agents),
                record: (c, results) => { for (const r of results) if (r.state === 'sent' || r.state === 'already_asked') { names.set(r.agent.toLowerCase(), r.agent); askedOf(c.id).set(r.agent.toLowerCase(), r.state === 'sent' ? 'Asked just now' : 'Already asked'); } },
            });
            if (batch.cancelled) return;
            res = batch.response; sentThreads = batch.sentThreads;
        } catch { res = { ok: false, status: 0, results: [], error: 'Coral could not be reached. Some earlier comments may already have been sent; their status stays in each thread.' }; }
        if (!current(k)) return;
        k.busy = false;
        if (!res.ok) k.error = res.error || 'Some comments could not be sent. Check each thread before trying again.';
        if (res.results.length) {
            k.results = res.results;
            const asked = askedOf(k.id);
            for (const r of res.results) if (k.queue.length === 1 && (r.state === 'sent' || r.state === 'already_asked')) names.set(r.agent.toLowerCase(), r.agent), asked.set(r.agent.toLowerCase(), r.state === 'sent' ? 'Asked just now' : 'Already asked');
            const n = res.results.filter(r => r.state === 'sent').length;
            announce(k.queue.length > 1 ? `Sent ${sentThreads} of ${k.queue.length} comments. Replies come into each comment’s own thread.` : n ? `Asked ${n} agent${n === 1 ? '' : 's'}. Their replies come into this thread.` : 'Nobody was asked.');
            if (n) for (const ms of [10000, 30000, 90000]) setTimeout(() => { if (current(k) && !isSignedOut()) refresh(); }, ms); // the agents' replies are replies in the thread: fetched a few times while they work
        } else { k.error = res.error || 'The comment was not sent.'; }
        redrawAsk(); for (const c of k.queue) redrawStatus(c.id);
        panel.querySelector('.ac-ask .ac-cancel')?.focus();
    }
    return { resetAsk, canAsk, askSetup, openAsk, openMany: list => { const queue = list.filter(canAsk); if (queue.length) return openAsk(queue[0], queue); }, askBlock, askedNow, statusWords, fillStatus };
}
