/* Start something on a computer (#20388, mock #20111): New agent, New team and New terminal on every row of the Computers list (this computer and remote ones). Each opens the launch flow with that
 * computer chosen, so the folders it asks about are that computer's. A computer that cannot run one (offline, key rejected, no hub) has the buttons off and the reason in words under them, never only grey. */
import { launchBlockReason } from './launch_server.js';
import { isHub, LOCAL_SERVER } from './server_base.js';
import { state } from './state.js';
import { loadStyles } from './lazy_styles.js';

await loadStyles('computer_start.css');

const START = [['agent', 'New agent'], ['team', 'New team'], ['terminal', 'New terminal']];

/** The reason a computer cannot start anything right now ('' when it can), in the words the row shows under its buttons. */
export function startBlockReason(id) { return launchBlockReason(id, isHub(), state.servers); }

/** The three buttons of one computer, and the reason under them when they are off. id is the computer's server id ('local' for this one). extra: { reason } says why the row cannot start anything when the launch
 *  rules do not (Hub access View, offline); { change: { label, run } } puts a link in that sentence to fix it. */
export function startCell(id, label, el, extra = {}) {
    const wrap = el('div', 'computer-start');
    const blocked = extra.reason || startBlockReason(id || LOCAL_SERVER);
    const group = el('div', 'computer-start-actions'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', `Start on ${label}`);
    for (const [kind, text] of START) {
        const b = el('button', `btn${kind === 'agent' ? ' btn-primary' : ''} computer-start-btn`, text);
        b.type = 'button'; b.dataset.computerStart = kind; b.dataset.computerId = id || LOCAL_SERVER;
        if (blocked) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.title = blocked; }
        b.addEventListener('click', e => { e.stopPropagation(); startOn(id, kind); }); // the row opens the computer's page: the button must not
        group.append(b);
    }
    wrap.append(group);
    if (blocked) {
        const note = el('p', 'computer-start-note', blocked);
        if (extra.change) { const a = el('button', 'btn-link computer-start-change', extra.change.label); a.type = 'button'; a.addEventListener('click', e => { e.stopPropagation(); extra.change.run(); }); note.append(' ', a); }
        wrap.append(note);
    }
    return wrap;
}

/** Open the launch flow for kind ('agent' | 'team' | 'terminal') on computer id. */
export function startOn(id, kind) {
    window.showLaunchModal?.(id === LOCAL_SERVER || !id ? undefined : id);
    window._selectLaunchType?.(kind);
}
