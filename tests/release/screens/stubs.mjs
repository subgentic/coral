// The few answers the isolated server cannot give, for the page that needs the server in that state. Each is named in a page entry (stub) and the card says so.
const UPDATE_STAGED = {
    enabled: true, relaunch_available: true, installed: '2.0.6', state: 'staged', auto: true,
    staged: { version: '2.0.7', staged_at: '2026-10-29T03:00:00Z', days_ready: 0, verified: true, source: 'subgentic/coral' },
    relaunch: { available: true, reason: '', hub_allowed: false, tmux_agents_restart: false, ack: 'ack-1', restarts: [{ session_id: 'stub-1', name: 'Frontend Dev', state: 'working', resumes: true }, { session_id: 'stub-2', name: 'Writer', state: 'waiting', resumes: false }] },
    last_result: null, checked_at: '2026-10-29T03:05:00Z',
};

// name -> { match(url), body }: page.route answers a GET whose path matches with this JSON.
export const STUBS = {
    updateStaged: { match: u => new URL(u).pathname === '/api/system/update', body: UPDATE_STAGED },
};
