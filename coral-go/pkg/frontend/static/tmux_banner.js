/* Startup checks only the terminal backend. Agent CLI checks load with the launch form. */
import { fetchSystemStatus } from './system_status.js';
const requests = new WeakMap();

function start(element) {
    requests.get(element)?.abort();
    const controller = new AbortController();
    requests.set(element, controller);
    return controller;
}
function current(element, controller) { return element.isConnected && requests.get(element) === controller; }

export async function checkTmux(force = false) {
    const banner = document.getElementById('tmux-missing-banner');
    if (!banner) return;
    const controller = start(banner);
    const title = banner.querySelector('strong');
    const message = document.getElementById('tmux-check-message');
    const command = banner.querySelector('.tmux-missing-banner-cmd');
    const button = document.getElementById('tmux-check-again');
    button.disabled = true; button.textContent = 'Checking…';
    try {
        const response = await fetchSystemStatus({fresh:force});
        if (!response.ok) throw new Error(`Could not check tmux (HTTP ${response.status}).`);
        const data = await response.json();
        if (!data || typeof data.tmux_available !== 'boolean') throw new Error('Could not check tmux: unexpected response.');
        if (!current(banner,controller)) return;
        if (data.tmux_available || data.tmux_required === false || data.effective_backend === 'pty') { banner.style.display='none'; return; }
        title.textContent = 'tmux is not installed.';
        message.textContent = 'Coral needs it to run agents.';
        const install = data.tmux_install_command;
        command.hidden = !install;
        document.getElementById('tmux-missing-banner-cmd-text').textContent = install || '';
        banner.style.display = '';
    } catch (error) {
        if (!current(banner,controller) || error.name === 'AbortError') return;
        title.textContent = 'tmux check failed.'; message.textContent = error instanceof SyntaxError ? 'The server returned an invalid response.' : error.message;
        command.hidden = true; banner.style.display = '';
    } finally {
        if (current(banner,controller)) { button.disabled=false;button.textContent='Check again'; }
    }
}


export function initPrerequisiteChecks() {
    document.getElementById('tmux-check-again')?.addEventListener('click',()=>checkTmux(true));
    checkTmux();
}
