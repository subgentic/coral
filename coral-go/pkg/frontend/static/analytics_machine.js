/* Which computer the Analytics tabs read (#15730). On a Hub-served dashboard the Usage, Inbox vs chat and Resource queue tabs and the efficiency comparison read ONE computer's numbers: this computer (the Hub
 * itself) or a linked one, chosen with the Computer picker. A dashboard of one computer has no picker and reads that computer, as it always did. No DOM and no request at load: the choice is a variable, and
 * a change is announced with one event so the open views read again. */
import { state } from './state.js';
import { isCloud, serverFetch } from './server_base.js';

const chosenNow = () => state.machineChosen || 'all'; // kept on the shared state so the Chats source (on the start path) can follow it; 'all' is the default: a page that can merge computers reads them all, any other page reads the first on its list (#20207)
export const MACHINE_EVENT = 'analytics-machine-change';
/** The computers that can be picked: this one (not on a Coral Hub's own page, which has none) and every linked one, offline ones too (they are named, not hidden). Empty off a Hub: nothing to pick. */
const seenAt = s => s.status === 'online' || s.online === true ? Number.MAX_SAFE_INTEGER : (Date.parse(s.last_seen) || 0);
/** The linked computers in picker order (#20207): online first, then offline, each group most recently seen first (an online one counts as seen now); ties keep the Hub's order. */
const linkedSorted = () => [...new Map((state.servers || []).filter(s => s && s.id && s.id !== 'local').map(s => [s.id, s])).values()].map((s, i) => [s, i]).sort(([a, i], [b, j]) => (machineOnline(b.id) - machineOnline(a.id)) || (seenAt(b) - seenAt(a)) || (i - j)).map(([s]) => s.id);
export const machineChoices = () => state.hub ? [...(isCloud() ? [] : ['local']), ...linkedSorted()] : [];
export const machineLabel = id => !id || id === 'local' ? 'This computer' : (state.servers || []).find(s => s.id === id)?.label || (state.servers || []).find(s => s.id === id)?.name || id;
export const machineOnline = id => !id || id === 'local' || (state.servers || []).some(s => s.id === id && s.status === 'online');
/** The computer being read: the choice if it is still on the list, else the first one on it (or this computer when there is no list). */
// 'local' (the fallback when nothing is linked) is the same origin: in cloud every caller must read through readNow, or stop on noComputerInCloud(), never use this id with fetch (#19591).
export const machineNow = () => { const c = machineChoices(); return c.includes(chosenNow()) ? chosenNow() : (c[0] || 'local'); };
/** True when the person is reading all linked computers (the default with two or more): only a page that can merge their rows asks. */
export const machineIsAll = () => chosenNow() === 'all' && machineChoices().length > 1;
export function pickMachine(id) { state.machineChosen = id || 'local'; document.dispatchEvent(new CustomEvent(MACHINE_EVENT, { detail: state.machineChosen })); }

/** Coral Hub's own page (cloud) has no computer of its own: with none linked there is nothing to read, and nothing is asked of this origin (coral-hub §7.2). */
export const noComputerInCloud = () => isCloud() && machineChoices().length === 0;
export const machineInventoryPending = () => isCloud() && !state.serversKnown && machineChoices().length === 0;
export const LINK_A_COMPUTER = 'Link a computer to see usage';
/** One Analytics read: this computer's own route off a Hub's page, the chosen computer's through /api/remote/<id>/ in cloud, never the same origin there and never with no computer chosen (the read is refused, not sent). */
export const readNow = (path, init) => !isCloud() ? fetch(path, init) : noComputerInCloud() ? Promise.reject(new Error(LINK_A_COMPUTER)) : serverFetch(machineNow(), path, init);

/** When a linked computer was last seen, as the Hub reports it ('' for this computer or when unknown). */
export const machineSeen = id => (state.servers || []).find(s => s && s.id === id)?.last_seen || '';

const entryOf = id => (state.servers || []).find(s => s && s.id === id);
/** The Coral version a linked computer reports (the Hub's coral_version, or a self-hosted hub's version) without its build suffix; '' when the Hub's list does not carry it: it is never guessed (#20319). */
export const machineVersion = id => {
    const e = entryOf(id), v = e && (e.coral_version || e.version), t = typeof v === 'string' ? v.trim() : '', i = t.indexOf('+'), short = (i > 0 ? t.slice(0, i) : t).replace(/^v/, '');
    return /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.]{1,40})?$/.test(short) ? short : '';
};
/** What the owner chose for the Hub's access to a computer: 'view', 'interact' or 'launch'; '' when the Hub's list carries no choice (it is not assumed). */
export const machineAccess = id => { const m = entryOf(id)?.access_mode; return m === 'launch' || m === 'follow' ? 'launch' : m === 'interact' || m === 'view' ? m : ''; };
/** An online computer the Hub says is too old (below its minimum, or an update that is required), or that a read just found too old (a 409 coral_too_old, markTooOld). */
export const machineNeedsUpdate = id => { const e = entryOf(id); return !!e && machineOnline(id) && (e.below_minimum === true || e.update === 'required' || !!(state.machineTooOld && state.machineTooOld[id])); };
export const markTooOld = id => { state.machineTooOld = { ...(state.machineTooOld || {}), [id]: true }; };

/** 'today at 09:12', 'yesterday at 18:40' or '3 Nov' (the mock's wording): the card and the list say the same time the same way. */
export function connectedWords(seen, now = new Date()) {
    const d = new Date(typeof seen === 'number' && seen < 1e12 ? seen * 1000 : seen);
    if (Number.isNaN(d.getTime())) return 'a while ago';
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), gap = Math.round((day(now) - day(d)) / 864e5);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (gap === 0) return `today at ${hm}`;
    if (gap === 1) return `yesterday at ${hm}`;
    return `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
}
