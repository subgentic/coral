/* Edits made in Dropbox, held for the Operator, as items of the Inbox's Needs you (Dropbox stage 5a piece 3, #14777). One row a held edit, from this
 * computer's own Dropbox status (Coral's name for the file, the edit's size and type, when Coral saw it, the version Promote would make now, and the
 * file's place in Dropbox's own web view). Through Coral Hub there are none: the decision is this computer's alone (Security's SHOULD G on #14714).
 * The row's actions: Use it as version N, Keep it separate, and Open in Dropbox to look first (Coral has not shown what changed). */
// No imports: inbox_tab.js sums the count at load, and a module this one imported could be loading it (as needs_skills.js). The caller passes how a
// path reaches this computer (serverFetch with the local server): this module never makes a bare request.
const LOCAL_SERVER = 'local';

let pending = [];

/** Read the held edits (this computer only; on any Hub page, none and nothing asked). `get(path, options)` reaches this computer. A refused or failed
 *  read keeps nothing: the Settings block says why. */
export async function loadDropboxEdits({ hub = false, get = null } = {}) {
    if (hub || typeof get !== 'function') { pending = []; return pending; }
    try {
        const r = await get('/api/dropbox/status', { cache: 'no-store' });
        if (!r.ok) { pending = []; return pending; }
        const d = await r.json();
        const items = d && d.edits && Array.isArray(d.edits.items) ? d.edits.items : [];
        pending = items.filter(e => e && /^[0-9a-f]{32}$/.test(String(e.doc_id || '')));
    } catch { pending = []; }
    return pending;
}

/** Words Coral itself chose, as one line (hidden characters written out, as needs_skills.js does): the file's name comes from Coral's own record. */
const marked = t => String(t == null ? '' : t).replace(/[\p{Cc}\p{Cf}]/gu, c => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`).replace(/\s+/g, ' ').trim();

const seenWhen = e => { const t = Date.parse(e.seen_at || ''); return Number.isNaN(t) ? '' : new Date(t).toLocaleString(); };

/** The rows Needs you draws, in the shape of the other items. */
export const dropboxEditRows = () => pending.map(e => ({
    dropboxEdit: e, session_id: `dropbox_edit:${e.doc_id}`, display_name: marked(e.name), board_project: '', server: LOCAL_SERVER, waiting_kind: 'dropbox_edit',
    waiting_summary: `Edited in Dropbox${seenWhen(e) ? ` · the version Coral saw on ${seenWhen(e)}` : ''} · Coral has not shown you what changed`, waiting_since: e.seen_at,
}));

export const dropboxEditName = e => marked(e.name);
export const dropboxEditLine = e => `${marked(e.name)} was edited in Dropbox`;
export const dropboxEditCount = () => pending.length;

/** Send the Operator's decision; a second one (another click, the other button, the Settings list) is refused by the server and said so. */
async function decideDropboxEdit(e, action, send) {
    const doc = String(e && e.doc_id || '');
    if (!/^[0-9a-f]{32}$/.test(doc) || (action !== 'promote' && action !== 'separate') || typeof send !== 'function') return { ok: false, text: '' };
    let r;
    try { r = await send(`/api/dropbox/edits/${doc}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' }); } catch { return { ok: false, text: "Couldn't reach Coral. Try again." }; }
    let body = {};
    try { body = await r.json(); } catch { /* no body */ }
    pending = pending.filter(p => p.doc_id !== doc || !(r.ok || r.status === 409));
    if (r.status === 409) return { ok: false, text: `${marked(e.name)}: ${String(body.error || 'this edit was already decided.')}` };
    if (!r.ok) return { ok: false, text: String(body.error || "Couldn't record that. Try again.") };
    return { ok: true, text: action === 'promote' ? `${marked(e.name)}: the edit is version ${Number(body.version) || ''} now.` : `${marked(e.name)}: the edit is kept as its own file.` };
}

/** The row's actions, built with the Inbox's own element helper and request (passed in: this module has no imports). `done(text)` says the outcome. */
export function dropboxEditActions(e, el, done, send) {
    const box = el('div', 'inbox-review-actions');
    const n = Number(e.next_version) || 2;
    const use = el('button', 'btn btn-small', `Use as version ${n}`); use.type = 'button'; use.setAttribute('aria-label', `Use the edit of ${dropboxEditName(e)} made in Dropbox as version ${n}`);
    const keep = el('button', 'btn btn-small', 'Keep separate'); keep.type = 'button'; keep.setAttribute('aria-label', `Keep the edit of ${dropboxEditName(e)} made in Dropbox as its own file`);
    for (const [b, action] of [[use, 'promote'], [keep, 'separate']]) {
        b.addEventListener('click', async ev => { ev.stopPropagation(); use.disabled = keep.disabled = true; const out = await decideDropboxEdit(e, action, send); done(out.text, out.ok); use.disabled = keep.disabled = false; });
    }
    box.append(use, keep);
    const url = String(e.dropbox_url || '');
    if (url.startsWith('https://www.dropbox.com/')) {
        const a = el('a', 'inbox-dropbox-look', 'Open in Dropbox'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.setAttribute('aria-label', `Open ${dropboxEditName(e)} in Dropbox to look at the edit first`);
        a.addEventListener('click', ev => ev.stopPropagation());
        box.prepend(a);
    }
    return box;
}

/** Opening the row shows the Dropbox block in Settings, where the same decision is. */
export const openDropboxEdit = () => { if (typeof window.showSettingsModal === 'function') window.showSettingsModal('cleanup'); };
