/* The chats Coral did not start (#11970): a new Coral lists only its own agents' chats; the Claude Code, Codex... history already on the computer waits for the person to import it (GET and POST /api/history-import). */
import { isCloud } from './server_base.js';
import { importOnce } from './import_once.js';
const { historyFetch } = await importOnce('./history_source.js');
const NAMES = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', pi: 'Pi', opencode: 'opencode', gemini: 'Gemini' };
let offer = null; // { imported, found, sources } while chats wait; null once imported or on a Hub

export async function loadImportOffer() {
    if (isCloud() || (offer && !offer.found)) return;
    try { const r = await historyFetch('/api/history-import'); const d = r && r.ok ? await r.json() : null; offer = d && !d.imported ? d : null; } catch { /* no offer */ }
}
export const importSignature = () => (offer ? offer.found : -1);
/** The empty All chats line's words and button, or {} when nothing waits. */
export function importEmpty(redraw) {
    if (!offer || !offer.found) return {};
    const from = Object.keys(offer.sources || {}).map(k => NAMES[k] || k).join(', ');
    return { hint: `${offer.found} earlier ${offer.found === 1 ? 'chat was' : 'chats were'} found on this computer (${from}). They are not listed until you import them.`, action: { label: `Import ${offer.found} earlier ${offer.found === 1 ? 'chat' : 'chats'} from ${from}`, run: () => importEarlier(redraw) } };
}
export async function importEarlier(redraw) {
    try { const r = await historyFetch('/api/history-import', { method: 'POST' }); if (!r || !r.ok) throw new Error('not imported'); offer = null; } catch { (await importOnce('./utils.js')).showToast?.('The chats could not be imported', true); return false; }
    redraw?.();
    return true;
}
