/* The list of a file's versions (#15285): "3 earlier versions" opens it. One row per version, oldest first, numbered v1, v2, v3 across the rounds, with when, who made it and Open; the newest is marked.
 * Restore (given by the caller when someone can be asked) asks the uploader to put that version back as the next one, after asking the person first. Loaded only when the list is opened. All text is set with textContent. */
import { importOnce } from './import_once.js';
const { readVersions } = await importOnce('./versions_read.js');
import { markHidden } from './visible_marks.js';
import { splitKey } from './server_base.js';
const { loadStyles } = await importOnce('./lazy_styles.js');

const shown = t => markHidden(String(t || ''), { strict: true }).trim();
const when = iso => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : t.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };

const madeByYou = v => v.role === 'operator' || v.source === 'edit'; // the person's own: an upload as the Operator or an edit in the dashboard (#15329, #15369); one test for the series and the fallback list

/** The versions of the file the row stands for, oldest first: [{ n, hex, at, who, note, current }]. The server's series when it has one, else the older uploads of the same name the row already holds (`earlier`) and itself, each marked `guess`: they are not a series (#18644). */
export async function versionsOf({ hex, server, board, current, earlier }) {
    try {
        const { response: r, dropped } = await readVersions(server, hex, board, { reuse: true });
        if (!dropped.length && r.ok) {
            const d = await r.json();
            if (Array.isArray(d) && d.length > 1) {
                const rows = d.slice().sort((a, b) => a.version - b.version);
                return rows.map((v, i) => ({ n: v.version, hex: v.digest, at: v.at, who: v.edited_in_dropbox ? 'Edited in Dropbox' : v.role || v.uploader || '', you: madeByYou(v), note: v.note || '', current: i === rows.length - 1 }));
            }
        }
    } catch { /* no series: the row's own older uploads below */ }
    const all = [...(earlier || []), current].filter(Boolean).sort((a, b) => String(a.created_at || a.at || '').localeCompare(String(b.created_at || b.at || '')));
    return all.map((v, i) => ({ n: i + 1, hex: v.hex, at: v.created_at || v.at || '', who: v.produced_by || v.role || '', you: madeByYou(v), current: i === all.length - 1, guess: true }));
}

/** Open the list. opts: { hex, server, board, name, current, earlier, open(version), restore?(version) } where restore resolves when the uploader was asked. */
export async function openVersionList(opts) {
    await loadStyles('version_list.css');
    const versions = await versionsOf(opts);
    const dlg = document.createElement('dialog');
    dlg.className = 'modal-content dlg-form version-list-dialog'; dlg.setAttribute('aria-labelledby', 'version-list-title');
    const title = document.createElement('h2'); title.id = 'version-list-title'; title.tabIndex = -1; const guess = versions.some(v => v.guess); // no series: uploads of the same name, not versions (#18644)
    title.textContent = `${guess ? 'Uploads named' : 'Versions of'} ${shown(opts.name)}`;
    const list = document.createElement('ul'); list.className = 'version-list';
    const aside = document.createElement('p'); aside.className = 'version-list-guess'; aside.hidden = !guess;
    if (guess) aside.textContent = 'Other uploads with the same name. They are not versions of one file, so there is no Restore or Compare here. To make a series, upload the next one with --new-version-of.';
    const status = document.createElement('p'); status.className = 'inbox-ask-error'; status.setAttribute('role', 'status');
    const finish = () => { dlg.close(); dlg.remove(); };
    const confirmRestore = (v, li) => {
        const sure = document.createElement('div'); sure.className = 'version-list-confirm';
        const q = document.createElement('p'); q.textContent = `Ask ${v.you ? 'the uploader' : shown(v.who) || 'the uploader'} to put v${v.n} back as the newest version? Nothing is changed until they do it.`;
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
    for (const [i, v] of versions.entries()) {
        const li = document.createElement('li'); li.className = 'version-list-entry'; if (!v.guess) li.dataset.version = String(v.n); if (v.current) li.setAttribute('aria-current', 'true');
        const name = document.createElement('span'); name.className = 'version-list-name'; name.textContent = `${v.guess ? 'Upload' : 'v' + v.n}${v.current ? ' (newest)' : ''}`;
        const who = document.createElement('span'); who.className = 'version-list-who'; who.textContent = [when(v.at), v.you ? 'You' : shown(v.who) ? `${shown(v.who)}, an agent` : ''].filter(Boolean).join(' · '); // who made it: you (an edit in the dashboard) or an agent (#15329)
        const actions = document.createElement('span'); actions.className = 'version-list-actions';
        const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btn-small version-list-open'; open.textContent = 'Open'; open.setAttribute('aria-label', v.guess ? `Open the upload of ${when(v.at)}` : `Open v${v.n}`);
        open.addEventListener('click', () => { finish(); opts.open(v); });
        actions.append(open);
        if (i > 0 && !v.guess) {
            const compare = document.createElement('button'); compare.type = 'button'; compare.className = 'btn btn-small version-list-compare';
            compare.textContent = `Compare with v${versions[i - 1].n}`;
            compare.addEventListener('click', async () => {
                if (dlg.dataset.comparing) return;
                dlg.dataset.comparing = '1'; compare.disabled = true;
                try { await (await importOnce('./artifact_list_compare.js')).showComparison(dlg, opts, versions[i - 1], v); }
                catch (e) { status.textContent = e.message || 'Could not compare these versions.'; }
                finally { delete dlg.dataset.comparing; compare.disabled = false; }
            });
            actions.append(compare);
        }
        if (!v.current && !v.guess && opts.restore) {
            const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'btn btn-small version-list-restore'; rb.textContent = 'Restore'; rb.setAttribute('aria-label', `Restore v${v.n}`);
            rb.addEventListener('click', () => confirmRestore(v, li)); actions.append(rb);
        }
        li.append(name, who, actions);
        if (v.note) { const note = document.createElement('span'); note.className = 'version-list-note'; note.textContent = shown(v.note); li.append(note); } // what the uploading agent said this version changed (--note, #17119): text, never markup
        list.append(li);
    }
    const buttons = document.createElement('div'); buttons.className = 'inbox-ask-buttons';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.textContent = 'Close'; close.addEventListener('click', finish);
    buttons.append(close);
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    dlg.append(title, aside, list, status, buttons);
    document.body.append(dlg); dlg.showModal(); title.focus();
    return dlg;
}

// the review bar's lazy half (#15285, #15329): the newer version of a file, and the file view's own Approve
/** A newer version of this file than this one (#15285, #15329): one in Needs you, else the newest of the file's series, so an older file says so whether or not the newest is still waiting. { n, hex } or null. */
export async function newerOf(team, hex, { fresh = false } = {}) { // fresh: the series is read again, not the copy read when the viewer opened (#17460)
    const m = await importOnce('./inbox_reviews.js'), top = m.reviewItems().find(a => a.team === team && a.hex !== hex && (a.earlier || []).some(e => e.hex === hex));
    if (top) return { n: Number(top.version) > 1 ? Number(top.version) : (top.earlier || []).length + 1, hex: top.hex };
    try {
        const k = splitKey(team);
        const { response, dropped } = await readVersions(k.server, hex, k.name, { reuse: !fresh });
        if (!dropped.length && response.ok) {
            const list = await response.json();
            if (Array.isArray(list) && list.length > 1) { const last = list.reduce((a, b) => (b.version > a.version ? b : a)); if (last.digest !== hex) return { n: last.version, hex: last.digest }; }
        }
    } catch { /* no series: no newer version to name */ }
    return null;
}
