/* control runtime: extracted from controls.js without behavior changes (#8372). */

import { importOnce } from './import_once.js';
import { state } from './state.js';
import { showToast } from './utils.js';

// Lazy imports to avoid circular dependency (xterm_renderer imports controls)
let _xtermModule = null;
export async function _getXtermModule() {
    if (!_xtermModule) _xtermModule = await importOnce('./xterm_renderer.js');
    return _xtermModule;
}

// A sleeping agent has no terminal to receive input. The composer hides the
// send controls; this is the barrier behind them for every send path.
export function sleepingBlocked(silent = false) {
    if (!(state.currentSession && state.currentSession.sleeping)) return false;
    if (!silent) showToast("Agent is sleeping — wake it to send commands", true);
    return true;
}
