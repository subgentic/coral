/* Share to Google Docs (#19996, goal #265; slice A of #20010): the dialog the file's More actions menu opens, next to Share via Dropbox and built the same way: a native
 * <dialog> (Escape, its × and Cancel close it; the focus goes back to the opener), one primary action at a time, every word ours and set as text. It is this computer's
 * Operator only (the server refuses everyone else), only for a Markdown file, and only while the experimental switch "Share to Google (experimental)" is on in Settings.
 * First press: a new Doc is made from the file; a later press on a newer version changes only what differs in the same Doc. The sign-in is kept on this computer; where it
 * is not, the dialog says so. Google's own words never reach the page. */
import { el as mk } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
import { serverUrl } from './server_base.js';

const HEX_RE = /^[a-f0-9]{64}$/;
const DOC_RE = /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit$/;

let dialog = null;
const close = () => { if (dialog && dialog.open) dialog.close(); };

async function call(method, url) {
    let r, j = {};
    try { r = await fetch(url, { method, cache: 'no-store' }); } catch { return { status: 0, body: { error: "Couldn't reach Coral. Try again." } }; }
    try { j = await r.json(); } catch { /* no body */ }
    return { status: r.status, body: j || {} };
}

/** Whether the menu item is offered: the experimental switch is on (GET /api/gdoc/status). Any failure counts as off. */
export async function gdocOffered() {
    const r = await call('GET', serverUrl('/api/gdoc/status', 'local'));
    return r.status === 200 && r.body.enabled === true;
}

const btn = (text, cls, onClick) => { const b = mk('button', cls || 'btn', text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

function ensureDialog(opener) {
    loadStyles('dropbox.css'); // the same dialog look as Share via Dropbox
    if (!dialog) {
        dialog = mk('dialog', 'modal-content dlg-form dropbox-share-dialog');
        dialog.id = 'gdoc-share-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'gdoc-share-title');
        document.body.appendChild(dialog);
        document.addEventListener('coral:route-changed', close);
        window.addEventListener('popstate', close);
        dialog.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
    }
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    dialog.addEventListener('close', () => { if (opener && opener.isConnected) opener.focus({ preventScroll: true }); }, { once: true });
    const head = mk('div', 'modal-header'); const h = mk('h3', null, 'Share to Google Docs'); h.id = 'gdoc-share-title';
    const x = btn('×', 'btn btn-icon modal-close', close); x.setAttribute('aria-label', 'Close'); head.append(h, x);
    const body = mk('div', 'modal-body dropbox-share-body');
    const say = mk('p', 'field-error dropbox-share-say'); say.setAttribute('role', 'alert'); say.hidden = true;
    const acts = mk('div', 'modal-actions modal-footer');
    dialog.append(head, body, say, acts);
    return { h, body, say, acts };
}

const primary = (text, onClick) => btn(text, 'btn btn-primary', onClick); // one primary at a time in a dialog state
const sayIt = (say, text) => { say.hidden = !text; say.textContent = text || ''; };

function docLink(url) {
    const a = mk('a', 'btn', 'Open the Doc'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', 'Open the Doc (opens a new tab)'); a.title = 'Opens a new tab';
    return a;
}

/** Open the dialog for an artifact. opts: { hex, filename, opener }. */
export async function openGdocDialog(opts) {
    const hex = String(opts.hex || '');
    const f = ensureDialog(opts.opener);
    f.body.append(mk('p', 'settings-hint', 'Reading the file’s sharing…'));
    f.acts.append(btn('Cancel', 'btn', close));
    dialog.showModal();
    if (!HEX_RE.test(hex)) { f.body.replaceChildren(mk('p', null, 'This file cannot be shared.')); return; }
    const res = await call('GET', serverUrl('/api/gdoc/status', 'local') + '?id=' + hex);
    if (!dialog.open) return;
    f.body.replaceChildren();
    if (res.status !== 200 || res.body.enabled !== true) { f.body.append(mk('p', null, 'Sharing to Google Docs is turned off. Turn on “Share to Google (experimental)” in Settings to use it.')); return; }
    f.h.textContent = `Share ${opts.filename || 'this file'} to Google Docs`;
    if (res.body.connected !== true) {
        f.body.append(mk('p', null, 'Google is not connected on this computer, so nothing can be shared yet.'));
        return;
    }
    f.body.append(mk('p', 'settings-hint dropbox-share-via', 'Through your Google account on this computer'));
    const url = DOC_RE.test(String(res.body.url || '')) ? res.body.url : '';
    const go = primary(res.body.shared ? 'Share this version again' : 'Share to Google Docs', async () => {
        sayIt(f.say, ''); go.disabled = true; note.textContent = 'Sharing…';
        const r = await call('POST', serverUrl(`/api/artifacts/${hex}/gdoc/share`, 'local'));
        if (!f.body.isConnected) return;
        go.disabled = false; note.textContent = '';
        if (r.status === 200) { done(f, r.body); return; }
        sayIt(f.say, String(r.body.error || 'Not shared. Try again.'));
    });
    const note = mk('p', 'settings-hint'); note.setAttribute('role', 'status');
    if (res.body.shared && url) {
        f.body.append(mk('p', null, 'This file is shared to a Google Doc of yours. Share it again after a change and only the changed text is updated in the Doc.'));
        f.acts.replaceChildren(btn('Close', 'btn', close), docLink(url), go);
    } else {
        f.body.append(mk('p', null, 'Makes a Google Doc of yours from this file. Share it again after a change and only the changed text is updated in the Doc.'));
        f.acts.replaceChildren(btn('Cancel', 'btn', close), go);
    }
    f.body.append(note);
    go.focus();
}

function done(f, res) {
    f.body.replaceChildren();
    const u = String(res.url || '');
    f.h.textContent = 'Shared to Google Docs';
    f.body.append(mk('p', null, res.created ? 'Shared: a new Google Doc was made.' : (Number(res.requests) > 0 ? 'The Doc was updated with your changes.' : 'The Doc already has this version.')));
    const acts = [];
    if (DOC_RE.test(u)) acts.push(docLink(u));
    const d = primary('Done', close);
    acts.push(d);
    f.acts.replaceChildren(...acts);
    d.focus();
}
