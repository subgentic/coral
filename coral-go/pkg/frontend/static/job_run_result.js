/* A finished run whose chat was not kept (#16958): See result shows what the run's agent said last, from the run's own record (result_text), instead of only a toast saying there is nothing to open.
 * A native <dialog> like the other small ones (Escape closes it, the focus goes back). The text is set with textContent, never as markup. Lazy: loaded the first time it is needed. */
import { el as mk } from './dom_el.js';
let dialog = null;

/** Why a run has no chat to open, by its status. */
export function noChatWords(status, error) {
    if (status === 'running' || status === 'pending') return 'this run is still going and has no chat yet. Its result appears here when it ends.';
    if (status === 'failed' || status === 'killed') return `this run ${status === 'killed' ? 'was stopped' : 'failed'} before it had a chat to show${error ? `: ${error.replace(/[.\s]+$/, '')}` : ''}.`;
    return 'this run finished, but its chat was not kept, so there is nothing to open.';
}

/** Open the dialog for the run of `jobName` with its agent's last words. opener: the control to take the focus back. */
export function openRunResult(jobName, text, opener) {
    if (!dialog) {
        dialog = mk('dialog', 'modal-content dlg-form reminder-dialog');
        dialog.id = 'run-result-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'run-result-title');
        document.body.appendChild(dialog);
    }
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    const head = mk('div', 'modal-header'); const h = mk('h3', null, `${jobName || 'Run'}: result`); h.id = 'run-result-title'; head.append(h);
    const body = mk('div', 'modal-body');
    const lead = mk('p', 'settings-hint', `This run's chat was not kept. This is what its agent said last.`);
    const pre = mk('pre', 'sched-prompt', text); pre.id = 'run-result-text';
    body.append(lead, pre);
    const acts = mk('div', 'modal-actions modal-footer');
    const done = mk('button', 'btn btn-primary', 'Close'); done.type = 'button'; done.addEventListener('click', () => dialog.close());
    acts.append(done);
    dialog.append(head, body, acts);
    dialog.addEventListener('close', () => { if (opener && opener.isConnected) opener.focus({ preventScroll: true }); }, { once: true });
    dialog.showModal();
    done.focus();
}
