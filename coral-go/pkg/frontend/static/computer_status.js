/* Read-only status and Hub history, opened separately from Settings (ST10). */
import { healthCard, localMachineHealth } from './machine_health.js';
import { el as mk } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
import { isCloud } from './server_base.js';
let dialog;
async function open(title) {
    await loadStyles('computer_status.css');
    if (dialog?.open) dialog.close();
    const opener = document.activeElement;
    const current = mk('dialog', 'modal-content computer-status-dialog'); dialog = current;
    current.id = 'computer-status-dialog';
    current.setAttribute('aria-labelledby', 'computer-status-title');
    const head = mk('div', 'modal-header'), h = mk('h2', null, title); h.id = 'computer-status-title'; head.append(h);
    const body = mk('div', 'modal-body'); body.tabIndex = 0;
    const foot = mk('div', 'modal-footer'), close = mk('button', 'btn', 'Close'); close.type = 'button';
    close.addEventListener('click', () => current.close()); foot.append(close);
    current.append(head, body, foot); document.body.append(current);
    current.addEventListener('close', () => { current.remove(); if (opener?.isConnected) opener.focus({preventScroll:true}); }, {once:true});
    current.showModal(); close.focus();
    return { dialog: current, body };
}
export async function showComputerStatus() {
    if (isCloud()) return;
    const view = await open('Computer status'); view.body.id = 'machine-health-local';
    const paint = () => view.body.replaceChildren(healthCard(localMachineHealth(), { title: 'This computer' }));
    paint();
    for (const event of ['coral:machine-health', 'coral:feed-state']) document.addEventListener(event, paint);
    view.dialog.addEventListener('close', () => { for (const event of ['coral:machine-health', 'coral:feed-state']) document.removeEventListener(event, paint); }, {once:true});
}
export async function showHubActions() {
    const view = await open('What Coral Hub did');
    const load = async () => {
        view.body.replaceChildren(mk('p', null, 'Loading actions…'));
        try {
            const response = await fetch('/api/system/hub-operator');
            if (!response.ok) throw new Error('unavailable');
            const data = await response.json();
            if (!Array.isArray(data.recent_actions)) throw new Error('unavailable');
            if (!view.dialog.open) return;
            const items = data.recent_actions.slice(0, 20);
            view.body.replaceChildren(mk('p', null, items.length ? 'The 20 most recent actions, newest first.' : 'No Coral Hub actions recorded.'));
            const list = mk('ol');
            for (const a of items) {
                const when = a.time || a.created_at || a.at, date = when ? new Date(when) : null;
                list.append(mk('li', null, [date && !isNaN(date) ? date.toLocaleString() : '', a.method, a.path, a.project ? `(${a.project})` : '', a.hub_user, a.status ? `→ ${a.status}` : ''].filter(Boolean).join(' ')));
            }
            view.body.append(list);
        } catch {
            if (!view.dialog.open) return;
            const error = mk('p', null, 'Could not read Coral Hub actions. Try again.'); error.setAttribute('role', 'alert');
            const retry = mk('button', 'btn', 'Retry'); retry.type = 'button'; retry.addEventListener('click', load);
            view.body.replaceChildren(error, retry);
        }
    };
    await load();
}
