/* Which computer the Analytics tabs read (#15730). On a Hub-served dashboard the Usage, Inbox vs chat and Resource queue tabs and the efficiency comparison read ONE computer's numbers: this computer (the Hub
 * itself) or a linked one, chosen with the Computer picker. A dashboard of one computer has no picker and reads that computer, as it always did. No DOM and no request at load: the choice is a variable, and
 * a change is announced with one event so the open views read again. */
import { state } from './state.js';
import { isCloud } from './server_base.js';

let chosen = 'local';
export const MACHINE_EVENT = 'analytics-machine-change';
/** The computers that can be picked: this one (not on a Coral Hub's own page, which has none) and every linked one, offline ones too (they are named, not hidden). Empty off a Hub: nothing to pick. */
export const machineChoices = () => state.hub ? [...(isCloud() ? [] : ['local']), ...new Set((state.servers || []).filter(s => s && s.id && s.id !== 'local').map(s => s.id))] : [];
export const machineLabel = id => !id || id === 'local' ? 'This computer' : (state.servers || []).find(s => s.id === id)?.label || (state.servers || []).find(s => s.id === id)?.name || id;
export const machineOnline = id => !id || id === 'local' || (state.servers || []).some(s => s.id === id && s.status === 'online');
/** The computer being read: the choice if it is still on the list, else the first one on it (or this computer when there is no list). */
export const machineNow = () => { const c = machineChoices(); return c.includes(chosen) ? chosen : (c[0] || 'local'); };
export function pickMachine(id) { chosen = id || 'local'; document.dispatchEvent(new CustomEvent(MACHINE_EVENT, { detail: chosen })); }
