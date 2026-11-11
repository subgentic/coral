/* The list of a file's versions (#15285): "3 earlier versions" opens it. One row per version, oldest first, numbered v1, v2, v3 across the rounds, with when, who made it and Open; the newest is marked.
 * Restore (given by the caller when someone can be asked) asks the uploader to put that version back as the next one, after asking the person first. Loaded only when the list is opened. All text is set with textContent. */
import { importOnce } from './import_once.js';
import { fetchSkewed, VERSIONS_KEYS } from './query_skew.js';
import { markHidden } from './visible_marks.js';
const { loadStyles } = await importOnce('./lazy_styles.js');

const shown = t => markHidden(String(t || ''), { strict: true }).trim();
const when = iso => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : t.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };

/** The versions of the file the row stands for, oldest first: [{ n, hex, at, who, current }]. The server's series when it has one, else the older uploads of the same file the row already holds (`earlier`) and itself. */
export async function versionsOf({ hex, server, board, current, earlier }) {
    try {
        const { response: r, dropped } = await fetchSkewed(server, `/api/artifacts/${hex}/versions`, board ? { board } : {}, { kind: 'versions', keys: VERSIONS_KEYS, retry: false });
        if (!dropped.length && r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d.length > 1) {
                const rows = d.slice().sort((a, b) => a.version - b.version);
                return rows.map((v, i) => ({ n: v.version, hex: v.digest, at: v.at, who: v.edited_in_dropbox ? 'Edited in Dropbox' : v.role || v.uploader || '', current: i === rows.length - 1 }));
            }
        }
    } catch { /* no series: the row's own older uploads below */ }
    const all = [...(earlier || []), current].filter(Boolean).sort((a, b) => String(a.created_at || a.at || '').localeCompare(String(b.created_at || b.at || '')));
    return all.map((v, i) => ({ n: i + 1, hex: v.hex, at: v.created_at || v.at || '', who: v.produced_by || v.role || '', current: i === all.length - 1 }));
}

/** Open the list. opts: { hex, server, board, name, current, earlier, open(version), restore?(version) } where restore resolves when the uploader was asked. */
export async function openVersionList(opts) {
    await loadStyles('version_list.css');
    const versions = await versionsOf(opts);
    const dlg = document.createElement('dialog');
    dlg.className = 'modal-content dlg-form version-list-dialog'; dlg.setAttribute('aria-labelledby', 'version-list-title');
    const title = document.createElement('h2'); title.id = 'version-list-title'; title.textContent = `Versions of ${shown(opts.name)}`;
    const list = document.createElement('ul'); list.className = 'version-list';
    const status = document.createElement('p'); status.className = 'inbox-ask-error'; status.setAttribute('role', 'status');
    const finish = () => { dlg.close(); dlg.remove(); };
    const confirmRestore = (v, li) => {
        const sure = document.createElement('div'); sure.className = 'version-list-confirm';
        const q = document.createElement('p'); q.textContent = `Ask ${shown(v.who) || 'the uploader'} to put v${v.n} back as the newest version? Nothing is changed until they do it.`;
        const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'btn btn-primary version-list-restore-confirm'; yes.textContent = 'Ask to restore';
        const no = document.createElement('button'); no.type = 'button'; no.className = 'btn'; no.textContent = 'Cancel';
        no.addEventListener('click', () => sure.remove());
        yes.addEventListener('click', async () => {
            yes.disabled = true;
            try { await opts.restore(v); status.textContent = `Sent to ${shown(v.who) || 'the uploader'}: put v${v.n} back.`; sure.remove(); }
            catch (e) { status.textContent = e && e.message ? e.message : 'Not sent.'; yes.disabled = false; }
        });
        sure.append(q, yes, no); li.append(sure); yes.focus();
    };
    for (const v of versions) {
        const li = document.createElement('li'); li.className = 'version-list-entry'; li.dataset.version = String(v.n); if (v.current) li.setAttribute('aria-current', 'true');
        const name = document.createElement('span'); name.className = 'version-list-name'; name.textContent = `v${v.n}${v.current ? ' (newest)' : ''}`;
        const who = document.createElement('span'); who.className = 'version-list-who'; who.textContent = [when(v.at), shown(v.who)].filter(Boolean).join(' · ');
        const actions = document.createElement('span'); actions.className = 'version-list-actions';
        const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btn-small version-list-open'; open.textContent = 'Open'; open.setAttribute('aria-label', `Open v${v.n}`);
        open.addEventListener('click', () => { finish(); opts.open(v); });
        actions.append(open);
        if (!v.current && opts.restore) {
            const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'btn btn-small version-list-restore'; rb.textContent = 'Restore'; rb.setAttribute('aria-label', `Restore v${v.n}`);
            rb.addEventListener('click', () => confirmRestore(v, li)); actions.append(rb);
        }
        li.append(name, who, actions); list.append(li);
    }
    const buttons = document.createElement('div'); buttons.className = 'inbox-ask-buttons';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.textContent = 'Close'; close.addEventListener('click', finish);
    buttons.append(close);
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    dlg.append(title, list, status, buttons);
    document.body.append(dlg); dlg.showModal(); (list.querySelector('.version-list-open') || close).focus();
    return dlg;
}
