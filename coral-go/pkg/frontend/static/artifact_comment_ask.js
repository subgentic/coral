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
export function createAsk({ st, panel, render, announce, refresh, ownHex, uploaderHint, ago = () => '' }) {
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
    // The line's rows: each agent asked into the thread with where its ask stands. The server's list wins once it shows more than Sent (a read, a reply); this page's own newest words ('Asked just now') cover only the moment after a send, before the list has caught up.
    function statusNow(id) {
        const m = new Map();
        const c = st.data && st.data.comments.find(x => x.id === id);
        for (const k of (c && c.asks) || []) if (k.open && k.agent) { m.set(k.agent.toLowerCase(), { k, words: askUi.askedWords(k) }); names.set(k.agent.toLowerCase(), k.agent); }
        for (const [role, words] of askedOf(id)) { const cur = m.get(role); if (!cur || askUi.askState(cur.k) === 'sent') m.set(role, { k: cur ? cur.k : null, words }); }
        return m;
    }
    /** The line under a comment that says where an agent has it (#14129): Sent to A, then Read by A (with the time the server saw its own read call return the comment), then A replied; at rest, and again as soon as a send answers (#12112: it kept saying "Not sent to an agent yet" beside "Asked just now"). Each name as written, a button to the agent's chat (#12168). */
    const fillStatus = (p, id) => {
        const rows = [...statusNow(id)]; p.replaceChildren();
        if (!rows.length) { p.textContent = st.undelivered && st.undelivered.get(id) ? `Not delivered: ${st.undelivered.get(id)}` : 'Not sent to an agent yet'; return; } // why it went nowhere (#15034)
        const all = (st.data && st.data.comments) || [], top = all.find(x => x.id === id);
        const newest = [top, ...all.filter(x => x.parentId === id && !x.deleted)].filter(Boolean).reduce((a, x) => (!a || Date.parse(x.createdAt) >= Date.parse(a.createdAt) ? x : a), null); // the newest message of the thread (#15119): a read mark says whether THIS was read, not an older one
        rows.forEach(([role, s], i) => {
            if (i) p.append('; ');
            const link = agentLink(names.get(role) || role, { board: boardTeamKey(st.server, st.board) });
            let state = s.k ? askUi.askState(s.k) : 'sent';
            const newestMine = !!newest && newest.mine, readNewest = !!s.k && !!s.k.readAt && (!newest || !(Date.parse(newest.createdAt) > Date.parse(s.k.readAt)));
            if (s.k && newestMine && newest !== top && state !== 'sent') state = readNewest ? 'read' : 'unread'; // the newest message is yours: replied or read earlier says nothing of it until the agent has read it
            if (state === 'replied') p.append(link, ` replied${s.k.replies > 1 ? ` (${s.k.replies} times)` : ''}`);
            else if (state === 'read') {
                p.append('Read by ', link);
                if (s.k.readAt) { const t = document.createElement('span'); t.textContent = `, ${ago(s.k.readAt)}`; t.title = s.k.readAt; p.append(t); }
            } else if (state === 'unread') p.append('Sent to ', link, `, not read yet${s.k.replies > 0 ? ` (it replied ${s.k.replies === 1 ? 'once' : `${s.k.replies} times`} before)` : ''}`);
            else p.append('Sent to ', link, sentWords(s.words));
            if (s.k && s.k.nudged && state !== 'sent') p.append(', reminded');
            if (s.k && s.k.limitReached) p.append('. The agent has reached its reply limit here'); // until the Operator writes again (#15034)
        });
    };
    /** The words after "Sent to A": a first ask says nothing more; one that was asked before says so plainly, not "(already asked)" (#15119). */
    const sentWords = words => { const w = String(words || '').replace(/^./, c => c.toLowerCase()); return !w ? '' : w.startsWith('already asked') ? ` (asked about this thread before${w.slice('already asked'.length)})` : ` (${w})`; };
    const statusWords = id => { const p = document.createElement('p'); fillStatus(p, id); return p.textContent; };
    const redrawStatus = id => { const p = panel.querySelector(`.ac-card[data-id="${id}"] .ac-ask-status`); if (p) fillStatus(p, id); };
    function askBlock() {
        const k = st.ask;
        return askUi.buildSendBlock({ id: k.id, board: st.board, agents: k.agents, empty: k.empty, picked: k.picked, asked: k.queue.length > 1 ? new Map() : askedNow(k.id), count: k.queue.length, long: k.queue.some(q => String(q.body || '').length > askUi.SEND_COMMENT_CAP), results: k.results, busy: k.busy, error: k.error,
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
    /** The picker starts with the uploader of the version being viewed ticked: only when that agent is in the list, can be asked now (awake, running) and is not already asked into this thread; otherwise nothing is ticked, as before. The others stay listed and can still be added, and this one unticked. */
    async function tickUploader(k) {
        try {
            if (!Array.isArray(k.agents)) return;
            const { uploaderOf } = await importOnce('./artifact_uploader.js');
            const who = String(await uploaderOf({ hex: k.context.hex, server: k.context.server, board: k.context.board }, uploaderHint?.()) /* the version DISPLAYED (captured at open), never the version the thread's comment was written on (#13995) */ || '').trim().toLowerCase();
            if (!who || !current(k)) return;
            const agent = k.agents.find(a => a.role.toLowerCase() === who);
            if (!agent || !agent.can || (k.queue.length === 1 && askedNow(k.id).has(who)) || k.picked.size >= askUi.MAX_AGENTS) return;
            k.picked.add(agent.role);
        } catch { /* no uploader known: nothing is ticked */ }
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
            await tickUploader(k); // the agent that uploaded this version starts ticked when it can be asked (#13995)
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
