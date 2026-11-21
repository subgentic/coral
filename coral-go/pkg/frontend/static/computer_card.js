/* One plain card for every "cannot" state of a computer (#20207, mock #20178): what is true (the headline names the computer), why in a sentence, the next step as a button,
 * and the raw code folded into "Details for support", never the headline. The words are text, never markup. */
import { importOnce } from './import_once.js';
const { loadStyles } = await importOnce('./lazy_styles.js');
await loadStyles('computer_card.css');
const { machineLabel, machineOnline, machineSeen, machineVersion, markTooOld, connectedWords } = await importOnce('./analytics_machine.js');
const { DOWNLOAD_URL } = await importOnce('./server_status.js');
const { go } = await importOnce('./nav.js');

const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, onClick, primary) => { const b = node('button', primary ? 'btn btn-primary btn-small' : 'btn btn-small', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };
/** Open the computer bar's list on the page, so "Switch computer" is one click away from the card. */
const switchComputer = barId => () => document.querySelector(`#${barId} .computer-bar-button`)?.click();
const openComputers = id => () => go(id ? { view: 'servers', id } : { view: 'servers' });

export { connectedWords }; // the words live with the computer helpers: the list and the card say a time the same way (#20319)

/** The card for one computer and one state. state: 'offline' | 'not-shared' | 'no-answer' | 'update-required' (the Hub's explicit minimum) | 'old' (the hedged 404 words until the Hub says why);
 *  what names the thing that could not be read ('automations'); detail is the support line; retry re-reads; barId is the page's computer bar. */
export function computerCard({ state, server, what, detail = '', min = '', retry, barId, onAll }) {
    const name = machineLabel(server), card = node('section', 'computer-card');
    card.setAttribute('data-computer-card', state); card.setAttribute('role', 'status');
    let headline, why, actions = [];
    const steps = node('p', 'computer-card-steps'); steps.hidden = true; // the card's own 'Show how to update': what to do, and the one download page
    if (state === 'offline') {
        const seen = machineSeen(server);
        headline = `${name} is offline`;
        why = `${seen ? `It was last connected ${connectedWords(seen)}. ` : ''}It reconnects by itself when its network is back. Its ${what} only run while it is on.`;
        actions = [retry && button('Try again', retry, true), button('Show another computer', switchComputer(barId)), onAll ? button('See all computers', onAll) : button('See all computers', openComputers())];
    } else if (state === 'not-shared') {
        headline = `${name} does not share its ${what} with the Hub`;
        why = `That computer keeps them private. Other pages on ${name} still work.`;
        actions = [button('Switch computer', switchComputer(barId), true), button('Open Computers', openComputers(server))];
    } else if (state === 'no-answer') {
        headline = `${name} did not answer`;
        why = 'This is usually a short network gap. Nothing was changed.';
        actions = [retry && button('Try again', retry, true), button('Switch computer', switchComputer(barId))];
    } else if (state === 'update-required') {
        // The mock's card (#20178): the headline says what is true, the sentence the version the Hub's list carries (no line when it does not) and what it can read from, three buttons.
        const ran = machineVersion(server), from = String(min || '').replace(/^v/, '');
        headline = `${name} needs an update to share its ${what}`;
        why = `${ran ? `It runs Coral ${ran}. ` : ''}${from ? `The Hub can read ${what} from Coral ${from} on. ` : ''}Everything else about ${name} still works.`;
        const how = button('Show how to update', () => { steps.hidden = !steps.hidden; how.setAttribute('aria-expanded', String(!steps.hidden)); }, true); how.setAttribute('aria-expanded', 'false');
        actions = [how, button('Switch computer', switchComputer(barId)), button('Open Computers', openComputers(server))];
        markTooOld(server);
    } else {
        headline = `${name} can't show ${what} here`;
        why = 'It may need a newer Coral.';
        actions = [retry && button('Retry', retry, true), button('Switch computer', switchComputer(barId))];
    }
    card.append(node('span', 'computer-card-mark', state === 'old' || state === 'not-shared' || state === 'update-required' ? 'i' : '!'));
    const body = node('div', 'computer-card-body');
    body.append(node('h3', 'computer-card-title', headline), node('p', 'computer-card-why', why));
    const row = node('div', 'computer-card-actions'); row.append(...actions.filter(Boolean)); body.append(row);
    if (state === 'update-required') {
        const link = node('a', '', 'the Coral download page'); link.href = DOWNLOAD_URL; link.target = '_blank'; link.rel = 'noopener noreferrer';
        steps.append(`On ${name}, install the latest Coral from `, link, `. It joins the Hub again by itself, then ${what} show here.`);
        body.append(steps);
    }
    if (detail) { const d = node('details', 'computer-card-details'); d.append(node('summary', '', 'Details for support'), node('p', '', detail)); body.append(d); }
    card.append(body);
    return card;
}

/** Which card a failed read is: a 403 is a computer that keeps it private, a 404 the hedged "may need a newer Coral", an offline computer is offline, and anything else (a network error, a 5xx, a timeout) did not answer. */
export const stateOfStatus = (server, status) => !machineOnline(server) ? 'offline' : status === 403 ? 'not-shared' : status === 404 ? 'old' : 'no-answer';

/** One short phrase for a computer whose rows are left out of a merged list ("lab-pc may need a newer Coral"). */
export const notShownText = (e, what) => { const name = machineLabel(e.server); return e.state === 'update-required' ? `${name} needs an update to share ${what}` : e.state === 'offline' ? `${name} is offline` : e.state === 'not-shared' ? `${name} does not share ${what}` : e.state === 'old' ? `${name} may need a newer Coral` : `${name} did not answer`; };
