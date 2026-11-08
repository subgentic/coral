/* Jump to agent (#14565): who a task's page opens, always (the Operator: it jumps even when the agent is not running, so the person lands on the agent and can wake it there). For a task in review the reviewer; otherwise the agent that has it. Pure: the task and the live agents of its own team (the caller filters by team and computer, so a same-named agent of another team is never the target) in, no DOM. */
const names = (list) => (Array.isArray(list) ? list.map(r => String(r && r.name !== undefined ? r.name : r || '').trim()).filter(Boolean) : []);
const isLive = (s) => !!s && !s.archived;
const named = (live, name) => live.find(s => isLive(s) && (s.display_name === name || s.name === name)) || null;

/** { kind: 'agent' | 'reviewer', name, session, state } or null when the task names nobody. session is the live row (null when the agent is not in the live list: it ended or sleeps on another computer's list); state is 'running', 'asleep' or 'ended' (its words in the button's tip). */
export function jumpTarget(task, live) {
    if (!task) return null;
    const status = String(task.status || '').toLowerCase();
    const found = (kind, name, session) => ({ kind, name: session ? (session.display_name || session.name) : name, session, state: !session ? 'ended' : session.sleeping ? 'asleep' : 'running' });
    if (task.review_requested || status === 'review_pending') {
        const who = names(task.reviewers);
        for (const name of who) { const session = named(live, name); if (session) return found('reviewer', name, session); }
        if (who.length) return found('reviewer', who[0], null);
    }
    const bySession = task.session_id ? live.find(s => isLive(s) && s.session_id === task.session_id) : null;
    const session = bySession || (task.assigned_to ? named(live, task.assigned_to) : null);
    if (session) return found('agent', task.assigned_to, session);
    const name = String(task.worked_by || task.assigned_to || '').trim();
    return name ? found('agent', name, null) : null;
}
