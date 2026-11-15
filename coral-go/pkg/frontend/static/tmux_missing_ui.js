/** Lazy-loaded UI for the tmux-missing banner and launch notice (#16713): keeps the start weight net zero. */
import { setHidden } from './dom_write.js';

export function ptyOfferNodes(container) {
    container.replaceChildren();
    const link = document.createElement('button'); link.type = 'button'; link.className = 'btn-link';
    link.textContent = 'switch to PTY in Settings'; link.addEventListener('click', () => window.showSettingsModal?.('terminal'));
    container.append('You can ', link, '. Agents will end when Coral restarts.');
}

export function renderTmuxMissingLaunch(element, data, recheck) {
    element.replaceChildren(); setHidden(element, false);
    element.setAttribute('role', 'status'); element.setAttribute('aria-live', 'polite');
    const label = document.createElement('span'); label.textContent = 'tmux is not installed.'; element.append(label);
    const pty = document.createElement('span'); ptyOfferNodes(pty); element.append(pty);
    const install = data.tmux_install_command;
    if (install) {
        const fold = document.createElement('details'); fold.className = 'disclosure cli-advanced-fold';
        const sum = document.createElement('summary'); sum.textContent = 'Install command'; fold.append(sum);
        const code = document.createElement('code'); code.textContent = install; fold.append(code);
        element.append(fold);
    }
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-small';
    btn.textContent = 'Check again'; btn.addEventListener('click', recheck); element.append(btn);
}
