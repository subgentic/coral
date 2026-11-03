/* Small terminal helpers shared by the backend status and the lazy Settings fields. */
export const TERMINAL_BACKEND_IDS = ['tb-choice', 'tb-fixed', 'tb-now', 'tb-pending', 'tb-autowake-on', 'tb-autowake-cap']; // the ids of the rows that start hidden
// The one line under the backend choice says what the chosen backend does (#9490): it follows the select, and the pty sentence says they wake next time only while Wake agents after a restart is on (#6263).
const BACKEND_HINT = { tmux: "Agents keep running when you quit Coral, and can reach each other's terminals.", ptyWake: 'Agents stop when you quit Coral and wake next time.', pty: 'Agents stop when you quit Coral.' };
export const backendHint = () => {
    const sel = document.getElementById('tb-choice'), wake = document.getElementById('tb-autowake-on');
    return !sel || sel.value === 'tmux' ? BACKEND_HINT.tmux : (wake && wake.checked ? BACKEND_HINT.ptyWake : BACKEND_HINT.pty);
};
