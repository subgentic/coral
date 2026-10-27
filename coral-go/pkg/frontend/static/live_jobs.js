/* Jobs: the runs that are going now (cron and API-triggered), as the websocket tells them. Automations' Running now folder draws them (automations.js); this module keeps the list, tells the folder
 * when it changes, and says in the page's status line when a run starts or the last one ends. */

import { selectLiveSession } from './sessions.js';

let activeRuns = [];
const listeners = new Set();

export function initLiveJobs() {
    // Data comes via WebSocket — nothing to init
}

/** The runs going now (pending or running), newest first, as the last tick said them, and a way to be told when they change. */
export const liveRuns = () => activeRuns;
export const onLiveRuns = fn => { listeners.add(fn); return () => listeners.delete(fn); };

export function renderLiveJobs(runs) {
    activeRuns = runs || [];
    const status = document.getElementById('live-jobs-status'); // said once when a run starts or the last one ends, not on every update
    if (status) { const said = activeRuns.length ? `${activeRuns.length} job${activeRuns.length === 1 ? '' : 's'} running now` : ''; if (status.textContent !== said) status.textContent = said; }
    for (const f of listeners) f();
}

export function selectLiveJobRun(sessionId, agentType) {
    // Find the matching live session name from the current live sessions list
    // and delegate to selectLiveSession
    const name = agentType + '-' + sessionId;
    selectLiveSession(name, agentType, sessionId);
}
