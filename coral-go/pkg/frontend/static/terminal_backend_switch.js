/* The two confirmations of Settings > Terminal backend's switch (#3634), loaded when a switch is asked for, not at start (#15253): the wording is Security's (#3632). The caller passes the helpers it owns
 * (confirmWith, post, saveAndRestart), so this module imports nothing. switchBackend(st, want, helpers) is true when Coral is restarting on the backend, false when the person declined or it failed. */

import { showToast } from './utils.js';

export async function switchBackend(st, want, { confirmWith, post, saveAndRestart }) {
    if (want === 'pty' && st.running === 'tmux') {
        const n = st.running_agents || 0;
        const ok = await confirmWith('Switch to pty?',
            (n ? `Switching to pty ends the ${n} running agent${n === 1 ? '' : 's'}. Coral puts them to sleep first, then restarts on pty. `
                + 'Wake them from the dashboard afterwards: they resume their conversation, but a tool that is running now is not continued. '
                : 'No agents are running. Coral restarts on pty now. ')
            + 'After this, agents end whenever Coral restarts or upgrades.',
            n ? `Sleep ${n} agent${n === 1 ? '' : 's'} and restart on pty` : 'Restart on pty', { danger: n > 0 });
        if (!ok) return false;
        if (n) {
            const r = await post('/api/sessions/live/sleep-all');
            if (!r.ok) { showToast('Could not put the agents to sleep: nothing changed', true); return false; }
        }
        return saveAndRestart('pty');
    }
    if (want === 'tmux' && st.running === 'pty') {
        const ok = await confirmWith('Switch to tmux?',
            "Agents will keep running across Coral restarts after this. Any agent will be able to reach other agents' terminals. "
            + 'Coral restarts on tmux now; your sleeping agents wake as usual.', 'Restart on tmux', { danger: false });
        if (!ok) return false;
        return saveAndRestart('tmux');
    }
    return saveAndRestart(want);
}
