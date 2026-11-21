// A bulk send uses the existing per-thread endpoint sequentially. Stop when the
// panel closes/navigates, or an endpoint refuses a request; keep earlier results.
export async function sendCommentQueue(comments, { send, isCurrent, record }) {
    const combined = new Map();
    let response = { ok: true, results: [], error: '' }, sentThreads = 0;
    const several = comments.length > 1; // all N go as ONE message (#20240): each is held, the last delivers them together, or leaves them held as one while the agent is in a turn
    for (const [i, c] of comments.entries()) {
        if (!isCurrent()) return { cancelled: true };
        const part = await send(c, several ? { bundle: true, last: i === comments.length - 1 } : null);
        if (!isCurrent()) return { cancelled: true };
        record(c, part.results);
        for (const r of part.results) {
            const prior = combined.get(r.agent);
            if (!prior || prior.state === 'already_asked' || (several && ['sent', 'queued'].includes(prior.state) && ['sent', 'queued'].includes(r.state)) || (['sent', 'queued'].includes(prior.state) && !['sent', 'queued', 'already_asked'].includes(r.state))) combined.set(r.agent, r);
        }
        if (part.results.some(r => r.state === 'sent' || r.state === 'queued' || r.state === 'already_asked')) sentThreads++;
        response = { ...part, results: [...combined.values()] };
        if (!part.ok || !part.results.length) break;
    }
    return { response, sentThreads };
}
