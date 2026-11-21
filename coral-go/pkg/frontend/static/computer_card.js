/* One plain card for every "cannot" state of a computer (#20207, mock #20178): what is true (the headline names the computer), why in a sentence, the next step as a button,
 * and the raw code folded into "Details for support", never the headline. The words are text, never markup. */
import { importOnce } from './import_once.js';
const { loadStyles } = await importOnce('./lazy_styles.js');
await loadStyles('computer_card.css');
const { machineLabel, machineOnline, machineSeen } = await importOnce('./analytics_machine.js');
const { formatLastSeen } = await importOnce('./server_status.js');
const { go } = await importOnce('./nav.js');

const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, onClick, primary) => { const b = node('button', primary ? 'btn btn-primary btn-small' : 'btn btn-small', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };
/** Open the computer bar's list on the page, so "Switch computer" is one click away from the card. */
const switchComputer = barId => () => document.querySelector(`#${barId} .computer-bar-button`)?.click();
const openComputers = id => () => go(id ? { view: 'servers', id } : { view: 'servers' });

/** The card for one computer and one state. state: 'offline' | 'not-shared' | 'no-answer' | 'old' (the hedged 404 words until the Hub says why);
 *  what names the thing that could not be read ('automations'); detail is the support line; retry re-reads; barId is the page's computer bar. */
export function computerCard({ state, server, what, detail = '', retry, barId, onAll }) {
    const name = machineLabel(server), card = node('section', 'computer-card');
    card.setAttribute('data-computer-card', state); card.setAttribute('role', 'status');
    let headline, why, actions = [];
    if (state === 'offline') {
        const seen = machineSeen(server);
        headline = `${name} is offline`;
        why = `${seen ? `It was last seen ${formatLastSeen(seen)}. ` : ''}It reconnects by itself when its network is back. Its ${what} only run while it is on.`;
        actions = [retry && button('Try again', retry, true), button('Show another computer', switchComputer(barId)), onAll ? button('See all computers', onAll) : button('See all computers', openComputers())];
    } else if (state === 'not-shared') {
        headline = `${name} does not share its ${what} with the Hub`;
        why = `That computer keeps them private. Other pages on ${name} still work.`;
        actions = [button('Switch computer', switchComputer(barId), true), button('Open Computers', openComputers(server))];
    } else if (state === 'no-answer') {
        headline = `${name} did not answer`;
        why = 'This is usually a short network gap. Nothing was changed.';
        actions = [retry && button('Try again', retry, true), button('Switch computer', switchComputer(barId))];
    } else {
        headline = `${name} can't show ${what} here`;
        why = 'It may need a newer Coral.';
        actions = [retry && button('Retry', retry, true), button('Switch computer', switchComputer(barId))];
    }
    card.append(node('span', 'computer-card-mark', state === 'old' || state === 'not-shared' ? 'i' : '!'));
    const body = node('div', 'computer-card-body');
    body.append(node('h3', 'computer-card-title', headline), node('p', 'computer-card-why', why));
    const row = node('div', 'computer-card-actions'); row.append(...actions.filter(Boolean)); body.append(row);
    if (detail) { const d = node('details', 'computer-card-details'); d.append(node('summary', '', 'Details for support'), node('p', '', detail)); body.append(d); }
    card.append(body);
    return card;
}

/** Which card a failed read is: a 403 is a computer that keeps it private, a 404 the hedged "may need a newer Coral", an offline computer is offline, and anything else (a network error, a 5xx, a timeout) did not answer. */
export const stateOfStatus = (server, status) => !machineOnline(server) ? 'offline' : status === 403 ? 'not-shared' : status === 404 ? 'old' : 'no-answer';

/** One short phrase for a computer whose rows are left out of a merged list ("lab-pc may need a newer Coral"). */
export const notShownText = (e, what) => { const name = machineLabel(e.server); return e.state === 'offline' ? `${name} is offline` : e.state === 'not-shared' ? `${name} does not share ${what}` : e.state === 'old' ? `${name} may need a newer Coral` : `${name} did not answer`; };
