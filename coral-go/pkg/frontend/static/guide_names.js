/* A guide's name on their posts (#11457, the guide role): a guide is a person with a guide grant on ONE board; their board messages come with origin "hub_guide", subscriber_id and hub_user = their Coral Hub label
 * (hub-user-xxxxxxxx), and content that starts with the wrapper "[Guide <name> via Coral Hub, hub-user-xxxxxxxx] " (the name the roster had when it was written, else "a guide"). The Board shows who wrote it: the roster's
 * name now (the owner's GET /api/board/{project}/guide-roster, read once per board while the page lives; refused for anyone else), else the name in the wrapper, else "Guide hub-user-xxxxxxxx", with a "guide" tag so a
 * guide's post is never taken for the manager's or an agent's; the text is what comes after the wrapper. No imports: the board's renderers and the tests read it. */
const WRAP = /^\[Guide ([^\]]*?) via Coral Hub, (hub-user-[0-9a-f]{8})\] /;
const LABEL = /^hub-user-[0-9a-f]{8}$/;
const roster = new Map();      // board -> { label: name }
const asked = new Set();

/** The guide's Coral Hub label of a message, or '' (never a name a message claims for itself). */
export function guideLabel(m) {
    const l = String((m && (m.hub_user || m.subscriber_id)) || '');
    return LABEL.test(l) ? l : '';
}
export const isGuidePost = m => !!m && m.origin === 'hub_guide';
export function setGuideRoster(board, obj) { roster.set(String(board), obj && typeof obj === 'object' ? { ...obj } : {}); }

/** Reads the roster once per board (the owner's: anyone else is refused and the wrapper's name is used). */
export function ensureGuideRoster(board) {
    const key = String(board || '');
    if (!key || asked.has(key)) return;
    asked.add(key);
    fetch(`/api/board/${encodeURIComponent(key)}/guide-roster`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(j => { if (j && j.roster && typeof j.roster === 'object') setGuideRoster(key, j.roster); }).catch(() => {});
}

/** Who wrote it: the roster's name, else the wrapper's, else "Guide hub-user-xxxxxxxx". */
export function guideName(m, board = '') {
    const label = guideLabel(m);
    const named = label && (roster.get(String(board)) || {})[label];
    if (named && String(named).trim()) return String(named).trim();
    const w = WRAP.exec(String((m && m.content) || ''));
    const fromWrap = w && w[1].trim();
    if (fromWrap && fromWrap.toLowerCase() !== 'a guide') return fromWrap;
    return label ? `Guide ${label}` : 'A guide';
}

/** The text after the wrapper (the wrapper is for agents: the row says the author and the tag). */
export const guideText = m => String((m && m.content) || '').replace(WRAP, '');
