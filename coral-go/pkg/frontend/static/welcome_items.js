/* The Inbox's welcome items for a new install (#11443, the operator via coral-hub #139185): five rows in Needs you, each a real action that marks itself done when its step is seen.
 * The server turns them on for an install that has never run (inbox_welcome = on, server.go seedNewInstallInboxWelcome); one that has run never has the setting. What is done, read or dismissed is
 * kept in inbox_welcome_done (comma-separated ids) with the Coral's settings, so another browser agrees; when all five are done, or the person hides them, the setting goes off for good.
 * Detection is the step itself: an agent exists, a team exists, a computer or the Hub is connected. They are not alarms: not in the Inbox badge, no toast, no alert, and they sit under real work. */
import { state } from './state.js';
import { serverFetch, currentServer } from './server_base.js';
import { showConfirmModal } from './confirm_dialog.js';
import { registerActions } from './actions.js';
import { browserSession } from './safe_storage.js';

export const WELCOME_IDS = ['welcome', 'agent', 'team', 'connect', 'asks'];
export const WELCOME = {
    welcome: { title: 'Welcome to Coral', text: 'This is your Inbox. Anything an agent needs from you shows up here, so you never have to watch a terminal.', go: 'Got it', dismiss: false },
    agent: { title: 'Start your first agent', text: 'Pick a folder and a CLI, and Coral starts it for you.', go: 'New agent', dismiss: true },
    team: { title: 'Make a team so agents can work together', text: 'A team gives agents a shared board to talk and hand off work.', go: 'New team', dismiss: true },
    connect: { title: 'Connect a second computer or the Hub', text: 'Run agents on another computer, or reach this one from your phone.', go: 'Connect', dismiss: true, optional: true },
    asks: { title: 'How agents ask you for things', text: 'Approvals, dialogs and review artifacts all land here. A short read, then it clears.', go: 'Read it', dismiss: true },
};
const ASKS_TEXT = 'When an agent needs a decision it appears in Needs you with its question: a permission to allow, a question to answer, a plan to approve, or a dialog in its terminal that needs one click. A review artifact an agent made waits there too, marked For review. Answer from the list or open the agent. Once answered, the item leaves.';

export const welcomeOn = () => (state.settings || {}).inbox_welcome === 'on';
const doneList = () => new Set(String((state.settings || {}).inbox_welcome_done || '').split(',').map(s => s.trim()).filter(id => WELCOME_IDS.includes(id)));

let _teams = null, _teamsAt = 0; // the teams on this Coral (GET /api/board/projects): read while the team step is open, at most every 5 s
function readTeams() {
    if (Date.now() - _teamsAt < 5000) return;
    _teamsAt = Date.now();
    serverFetch(currentServer(), '/api/board/projects').then(r => r.ok ? r.json() : null).then(rows => {
        const had = _teams; _teams = Array.isArray(rows) ? rows.length : null;
        if (_teams !== had) document.dispatchEvent(new CustomEvent('coral:welcome-changed'));
    }).catch(() => {});
}

/** Whether the step of one item has happened. */
export function seen(id) {
    if (id === 'agent') return (state.liveSessions || []).length > 0;
    if (id === 'team') return _teams > 0;
    if (id === 'connect') return (state.servers || []).length > 0 || !!state.hub;
    return false;
}

/** The ids no longer to show: done, read or dismissed before, or their step is seen now. */
export const finished = () => { const d = doneList(); for (const id of WELCOME_IDS) if (seen(id)) d.add(id); return d; };

/** The welcome rows of Needs you (the Inbox draws them like a failed run: an item with its own actions), none when they are off. */
export function welcomeRows() {
    if (!welcomeOn()) return [];
    if (!finished().has('team')) readTeams();
    const d = finished();
    return WELCOME_IDS.filter(id => !d.has(id)).map(id => ({ welcome: { id, ...WELCOME[id] }, session_id: `welcome:${id}`, display_name: WELCOME[id].title, board_project: '', server: '', waiting_kind: 'welcome', waiting_summary: WELCOME[id].text, waiting_since: '' }));
}

let _saving = Promise.resolve();
function save(values) {
    Object.assign(state.settings || (state.settings = {}), values);
    _saving = _saving.then(() => fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) })).catch(() => {}); // kept for this page if it fails: the server shows them again next time
}

/** Keep the setting in step: a step seen is remembered (deleting the agent later brings nothing back), and with all five done the items are off for good. Safe to call often. */
export function syncWelcome() {
    if (!welcomeOn()) return;
    if (!finished().has('team')) readTeams();
    const have = doneList(), now = finished();
    if (now.size === have.size && [...now].every(id => have.has(id))) return;
    if (WELCOME_IDS.every(id => now.has(id))) { save({ inbox_welcome_done: [...now].join(','), inbox_welcome: 'off' }); return; }
    save({ inbox_welcome_done: [...now].join(',') });
}

function mark(id) {
    const d = finished(); d.add(id);
    save({ inbox_welcome_done: [...d].join(',') });
    syncWelcome();
    document.dispatchEvent(new CustomEvent('coral:welcome-changed'));
}

/** Hide every welcome item for good. */
export function hideAllWelcome() { save({ inbox_welcome: 'off' }); document.dispatchEvent(new CustomEvent('coral:welcome-changed')); }
export const dismissWelcome = id => mark(id);

/** An item's own action. */
export function runWelcome(id) {
    if (id === 'welcome') { mark('welcome'); return; }
    if (id === 'agent' || id === 'team') { window.showLaunchModal?.(); window._selectLaunchType?.(id); return; }
    if (id === 'connect') { window.switchNavTab?.('servers'); return; }
    if (id === 'asks') { const read = () => mark('asks'); showConfirmModal(WELCOME.asks.title, ASKS_TEXT, read, read, { label: 'Got it', cancelLabel: 'Close', danger: false }); }
}

/** Whether this page was opened at the bare address (no path, no query). The URL the person typed or tapped, not the live one: by the time the settings have loaded the app has moved to /agents (#11443). */
function bareStart() {
    let first = null;
    try { const timing = typeof PerformanceNavigationTiming === 'undefined' ? null : performance.getEntries().find(e => e instanceof PerformanceNavigationTiming); if (timing) first = new URL(timing.name); } catch { /* no entry for this page: the live address */ }
    const path = first ? first.pathname : location.pathname, query = first ? first.search : location.search;
    return (path === '/' || path === '') && !query;
}

/** A new install opens on the Inbox while it has welcome items, once per tab, only for the bare start (no link, no query). */
export function landOnWelcome() {
    if (!welcomeOn() || !welcomeRows().length) return;
    if (!bareStart()) return;
    if (browserSession.get('coral-welcome-landed')) return; // storage that is blocked reads as empty: every start lands, and the items are short-lived
    browserSession.set('coral-welcome-landed', '1');
    window.switchNavTab?.('hub-inbox');
}

registerActions({ 'inbox-go-agents': () => window.switchNavTab?.('agents') });
