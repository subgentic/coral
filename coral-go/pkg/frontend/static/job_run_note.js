// Why a run has no chat to open, by its status: a run still going has no See result (#17520, #16796). Loaded only when that toast shows.
export function noChatNote(job, page, sid) {
    const run = page?.rows.find(r => r.session_id === sid);
    const status = run?.status, error = String(run?.error_msg || '').slice(0, 200).replace(/[.\s]+$/, '');
    const why = status === 'failed' || status === 'killed' ? `this run ${status === 'killed' ? 'was stopped' : 'failed'} before it had a chat${error ? `: ${error}` : ''}.` : 'this run finished, but its chat was not kept.';
    return `${job ? `${job.name}: ` : ''}${why}`;
}
