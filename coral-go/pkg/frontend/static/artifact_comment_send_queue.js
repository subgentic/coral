// A bulk send uses the existing per-thread endpoint sequentially. Stop when the
// panel closes/navigates, or an endpoint refuses a request; keep earlier results.
export async function sendCommentQueue(comments, { send, isCurrent, record }) {
    const combined = new Map();
    let response = { ok: true, results: [], error: '' }, sentThreads = 0;
    for (const c of comments) {
        if (!isCurrent()) return { cancelled: true };
        const part = await send(c);
        record(c, part.results);
        for (const r of part.results) {
            const prior = combined.get(r.agent);
            if (!prior || prior.state === 'already_asked' || (prior.state === 'sent' && !['sent', 'already_asked'].includes(r.state))) combined.set(r.agent, r);
        }
        if (part.results.some(r => r.state === 'sent' || r.state === 'already_asked')) sentThreads++;
        response = { ...part, results: [...combined.values()] };
        if (!part.ok || !part.results.length) break;
    }
    return { response, sentThreads };
}
