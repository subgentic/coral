/* Share via Dropbox (#14944, design v3, mock v4 approved by the Operator on #197874): the dialog the file's More actions menu opens (and, for a
 * board chat, the chat's own menu). It asks every time who can open the copy: Specific people (by email, the default), People in your team (only
 * on a Dropbox team account) or Anyone with the link; everything is view only. Nothing is shared before the press; a link needs its own box
 * ticked; a file that looks like it holds a key or token needs a second box. After a link is made the dialog shows it with Copy link, Share…
 * (the system sheet, where the browser has one), Open in Dropbox and Stop sharing. A chat is previewed first, in a sandboxed frame (no scripts,
 * no same origin), and shared exactly as previewed. Every server text is set as text; a link is shown only when it is https on www.dropbox.com.
 * A native <dialog> opened with showModal(): Escape, its × and Cancel always close it, also while a request runs (that request still finishes;
 * Settings lists what it shared), and so does moving to another screen (the Operator's walk, #198059); Tab stays inside; the focus goes back to the
 * opener. This computer's Operator only: the server refuses everyone else, and the item is not offered through Coral Hub. */
import { el as mk } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';

const INFO = '/api/dropbox/share/', STOP = '/api/dropbox/share/stop/', CHAT = '/api/dropbox/share-chat/';
const LINK_RE = /^https:\/\/www\.dropbox\.com\/(scl|s)\//;
const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;

let dialog = null;
const close = () => { if (dialog && dialog.open) dialog.close(); };
const safeLink = (u) => typeof u === 'string' && LINK_RE.test(u) && !/[\s"'<>`\\]/.test(u);

async function call(method, url, body) {
    let r, j = {};
    try {
        r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch { return { status: 0, body: { error: "Couldn't reach Coral. Try again." } }; }
    try { j = await r.json(); } catch { /* no body */ }
    return { status: r.status, body: j || {} };
}

function ensureDialog(opener) {
    loadStyles('dropbox.css');
    if (!dialog) {
        dialog = mk('dialog', 'modal-content dlg-form dropbox-share-dialog');
        dialog.id = 'dropbox-share-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'dropbox-share-title');
        document.body.appendChild(dialog);
        document.addEventListener('coral:route-changed', close); // another screen: the dialog does not stay over it (#198059)
        window.addEventListener('popstate', close);
    }
    if (dialog.open) dialog.close();
    delete dialog.dataset.busy;
    dialog.replaceChildren();
    dialog.addEventListener('close', () => { if (opener && opener.isConnected) opener.focus({ preventScroll: true }); }, { once: true });
    return dialog;
}

function frame(titleText) {
    const head = mk('div', 'modal-header'); const h = mk('h3', null, titleText); h.id = 'dropbox-share-title';
    const x = btn('×', 'btn btn-icon modal-close', close); x.setAttribute('aria-label', 'Close'); head.append(h, x); // always there, always closes (#198059)
    const body = mk('div', 'modal-body dropbox-share-body');
    const say = mk('p', 'field-error dropbox-share-say'); say.setAttribute('role', 'alert'); say.hidden = true;
    const acts = mk('div', 'modal-actions modal-footer');
    dialog.append(head, body, say, acts);
    return { h, body, say, acts };
}

const btn = (text, cls, onClick) => { const b = mk('button', cls || 'btn', text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
const sayIt = (say, text) => { if (!text) { say.hidden = true; say.textContent = ''; return; } say.hidden = false; say.textContent = text; }; // shown first, then its words: a screen reader hears the change (UI Accessibility's SHOULD 5)

// busy disables the dialog's buttons while a request runs, and keeps Escape from closing it; when it ends, the control that had the focus (the
// button pressed, which lost it while disabled) has it again, when it is still there (UI Accessibility's SHOULD 1).
let busyFocus = null;
function busy(on) {
    if (!dialog) return;
    if (on) { dialog.dataset.busy = '1'; busyFocus = dialog.contains(document.activeElement) ? document.activeElement : null; } else delete dialog.dataset.busy;
    for (const b of dialog.querySelectorAll('button, input, textarea')) b.disabled = on && !b.classList.contains('modal-close');
    if (!on && busyFocus && busyFocus.isConnected && dialog.contains(busyFocus)) busyFocus.focus();
    if (!on) busyFocus = null;
}

const audienceWords = { people: 'Specific people', team: 'People in your team', public: 'Anyone with the link' };

/** Open the dialog for an artifact. opts: { hex, filename, opener }. */
export async function openShareDialog(opts) {
    const hex = String(opts.hex || '');
    ensureDialog(opts.opener);
    const f = frame('Share via Dropbox');
    f.body.append(mk('p', 'settings-hint', 'Reading your Dropbox…'));
    f.acts.append(btn('Cancel', 'btn', close));
    dialog.showModal();
    const res = await call('GET', INFO + hex);
    if (!dialog.open) return;
    f.body.replaceChildren();
    if (res.status === 403 && res.body.code === 'private') { f.body.append(mk('p', null, 'A private file is not shared.')); return; }
    if (res.status !== 200) { f.body.append(mk('p', null, String(res.body.error || "Couldn't read this file's sharing. Try again."))); return; }
    if (!res.body.connected) { f.body.append(mk('p', null, 'Connect Dropbox in Settings, Storage and cleanup, to share through it.')); return; }
    const info = res.body;
    f.h.textContent = `Share ${info.name || 'this file'} via Dropbox`;
    const live = Array.isArray(info.shares) ? info.shares.filter(s => s.state === 'live') : [];
    if (live.length) {
        f.body.append(sharesList(live, f));
        const again = btn('Share it again…', 'btn', () => { f.body.replaceChildren(); again.remove(); form(f, info, (body) => call('POST', INFO + hex, body), `version ${info.version || 1} as it is now`); document.getElementById('dropbox-share-name')?.focus(); }); // the Name box has the focus (UI Accessibility's SHOULD 2)
        f.acts.prepend(again);
        return;
    }
    form(f, info, (body) => call('POST', INFO + hex, body), `version ${info.version || 1} as it is now`);
}

/** Open the dialog for a board chat. opts: { project, ids, opener }. */
export async function openChatShareDialog(opts) {
    const project = String(opts.project || ''), ids = (opts.ids || []).map(Number).filter(n => n > 0);
    ensureDialog(opts.opener);
    const f = frame('Share this chat via Dropbox');
    f.body.append(mk('p', 'settings-hint', 'Making the page…'));
    f.acts.append(btn('Cancel', 'btn', close));
    dialog.showModal();
    const res = await call('POST', CHAT + encodeURIComponent(project) + '/preview', { ids });
    if (!dialog.open) return;
    f.body.replaceChildren();
    if (res.status !== 200) { f.body.append(mk('p', null, String(res.body.error || "Couldn't make the page. Try again."))); return; }
    if (!res.body.connected) { f.body.append(mk('p', null, 'Connect Dropbox in Settings, Storage and cleanup, to share through it.')); return; }
    const p = res.body;
    const n = Number(p.included || 0), left = Number(p.left_out || 0);
    f.body.append(mk('p', 'settings-hint', `One readable page of ${n} ${n === 1 ? 'message' : 'messages'}${left ? ` (${left} left out: Coral's own posts and messages to a group)` : ''}. ` +
        'Secrets that look like keys or tokens are removed. Check the preview for private names and paths. Images and attachments are not included.'));
    const pv = mk('iframe', 'dropbox-share-preview');
    pv.setAttribute('sandbox', ''); // no scripts, no same origin, no forms, no navigation (Security's INFO on 31cb747a4)
    pv.setAttribute('referrerpolicy', 'no-referrer'); pv.title = 'Preview of the page to share';
    pv.srcdoc = String(p.html || '');
    const show = btn('Open the preview', 'btn btn-small', () => { pv.hidden = !pv.hidden; show.textContent = pv.hidden ? 'Open the preview' : 'Hide the preview'; show.setAttribute('aria-expanded', String(!pv.hidden)); });
    pv.hidden = true; show.setAttribute('aria-expanded', 'false');
    f.body.append(show, pv);
    const formBox = mk('div');
    f.body.append(formBox);
    form({ ...f, body: formBox }, { ...p, secret: false }, (body) => call('POST', CHAT + encodeURIComponent(project), { ...body, ids, hash: p.hash }), 'the page as previewed');
}

// form is the choice and the press: the name recipients see, who can open it, and the button that says what happens.
function form(f, info, send, whatText) {
    const idb = 'dropbox-share';
    const nameL = mk('label', 'form-label', 'Name recipients will see'); nameL.htmlFor = `${idb}-name`;
    const name = mk('input', 'settings-input'); name.id = `${idb}-name`; name.type = 'text'; name.maxLength = 120; name.value = String(info.name || '');
    const size = Number(info.size || 0);
    const meta = mk('p', 'settings-hint', `${size >= 1024 ? Math.round(size / 1024) + ' KB' : size + ' bytes'} · ${whatText}. Shared as a copy in Dropbox › Shared from Coral; later changes here are not shared.`);
    const group = mk('div', 'dropbox-share-choices'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Who can open it');
    const choices = [['people', 'Specific people', 'Only the people you add, by email. Dropbox emails each one an invitation; they sign in to Dropbox to open it. View only.']];
    if (info.team) choices.push(['team', `People in ${info.team} (your Dropbox team)`, `Anyone in your team who has the link. View only.${info.can_expire ? ' Expires in 30 days.' : ''}`]);
    choices.push(['public', 'Anyone with the link', `Anyone with this link can open and download this file. ${info.can_expire ? 'It expires in 30 days.' : 'Your Dropbox plan cannot set an expiry: it does not expire unless you stop sharing.'}`]);
    const radios = {};
    for (const [value, label, hint] of choices) {
        const row = mk('label', 'dropbox-share-choice');
        const r = mk('input'); r.type = 'radio'; r.name = `${idb}-aud`; r.value = value; r.checked = value === 'people';
        const words = mk('span'); words.append(mk('b', null, label), mk('span', 'settings-hint', hint));
        row.append(r, words); group.append(row); radios[value] = r;
    }
    const emailsL = mk('label', 'form-label', 'Email addresses (one per line, or separated by commas)'); emailsL.htmlFor = `${idb}-emails`;
    const emails = mk('textarea', 'settings-input'); emails.id = `${idb}-emails`; emails.rows = 2;
    const peopleBox = mk('div', 'dropbox-share-people'); peopleBox.append(emailsL, emails);
    const linkOK = mk('label', 'dropbox-share-tick'); const linkTick = mk('input'); linkTick.type = 'checkbox'; linkTick.id = `${idb}-link-ok`;
    const linkWords = mk('span'); linkOK.append(linkTick, linkWords);
    const secretOK = mk('label', 'dropbox-share-tick'); const secretTick = mk('input'); secretTick.type = 'checkbox'; secretTick.id = `${idb}-secret-ok`;
    secretOK.append(secretTick, mk('span', null, 'This file looks like it contains a key or token. Share it by link anyway.'));
    f.body.append(nameL, name, meta, group, peopleBox, linkOK, secretOK);
    const go = btn('Share', 'btn btn-primary', null);
    f.acts.replaceChildren(btn('Cancel', 'btn', close), go);

    const parseEmails = () => emails.value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    const aud = () => Object.keys(radios).find(k => radios[k].checked) || 'people';
    const sync = () => {
        const a = aud(), link = a !== 'people';
        peopleBox.hidden = link;
        linkOK.hidden = !link; secretOK.hidden = !(link && info.secret);
        linkWords.textContent = a === 'team' ? `I understand anyone in ${info.team || 'my team'} who has the link can open it.` : 'I understand anyone with the link can open and download this file.';
        const n = parseEmails().length;
        go.textContent = a === 'people' ? (n ? `Share with ${n} ${n === 1 ? 'person' : 'people'}` : 'Share with people') : a === 'team' ? 'Create team link' : 'Create public link';
        go.disabled = link ? (!linkTick.checked || (info.secret && !secretTick.checked)) : n === 0;
    };
    for (const r of Object.values(radios)) r.addEventListener('change', () => { linkTick.checked = false; secretTick.checked = false; sync(); });
    emails.addEventListener('input', sync); linkTick.addEventListener('change', sync); secretTick.addEventListener('change', sync);
    sync();
    go.addEventListener('click', async () => {
        sayIt(f.say, '');
        const a = aud(), list = parseEmails();
        if (a === 'people') {
            const bad = list.find(e => !EMAIL_RE.test(e));
            if (bad) { sayIt(f.say, `“${bad.slice(0, 80)}” is not an email address.`); emails.focus(); return; }
            if (list.length > 20) { sayIt(f.say, 'Share with 20 people at most.'); emails.focus(); return; }
        }
        if (!name.value.trim()) { sayIt(f.say, 'Give the file a name recipients will see.'); name.focus(); return; }
        busy(true);
        const res = await send({ name: name.value.trim(), audience: a, emails: a === 'people' ? list : [], expire: true, confirm: true, ...(a !== 'people' && info.secret ? { secret_ok: secretTick.checked } : {}) });
        if (!f.body.isConnected) return; // closed (or opened again) meanwhile: this answer is not the dialog's any more
        if (!f.body.isConnected) return;
    busy(false);
        if (res.status === 200) { shared(f, res.body, a); return; }
        if (res.body.code === 'sign_in_again') { signInAgain(f); return; }
        sayIt(f.say, String(res.body.error || 'Dropbox did not share it. Try again.'));
        sync();
    });
    name.focus();
}

// shared is the dialog after the press: the link (when there is one) with its actions, or who it went to.
function shared(f, res, a) {
    f.body.replaceChildren(); sayIt(f.say, '');
    f.h.textContent = `Shared ${res.name || ''} via Dropbox`.replace('  ', ' ');
    f.body.append(mk('p', 'settings-hint', `A copy in Dropbox › Shared from Coral${res.folder ? ' › ' + String(res.folder).split('/').pop() : ''}.`));
    const acts = [];
    if (a === 'people') {
        const n = Number(res.people || 0);
        f.body.append(mk('p', 'dropbox-share-who', `Shared with ${n} ${n === 1 ? 'person' : 'people'}, view only. Dropbox emailed ${n === 1 ? 'them' : 'each of them'} an invitation.`));
    } else if (safeLink(res.link)) {
        const link = mk('input', 'settings-input dropbox-share-link'); link.type = 'text'; link.readOnly = true; link.value = res.link; link.setAttribute('aria-label', 'The shared link');
        f.body.append(link);
        const exp = res.expires_at ? new Date(res.expires_at) : null;
        f.body.append(mk('p', 'dropbox-share-who', `${a === 'team' ? 'Anyone in your Dropbox team who has this link' : 'Anyone with this link'} can view and download this file. ${exp && !Number.isNaN(exp.getTime()) ? 'It expires on ' + exp.toLocaleDateString() + '.' : 'It does not expire.'}`));
        acts.push(btn('Copy link', 'btn btn-primary', async () => { try { await navigator.clipboard.writeText(res.link); sayIt(f.say, ''); let ok = f.body.querySelector('.dropbox-share-copied'); if (!ok) { ok = mk('p', 'settings-hint dropbox-share-copied'); ok.setAttribute('role', 'status'); f.body.append(ok); } ok.textContent = ''; ok.textContent = 'Copied.'; } catch { link.select(); sayIt(f.say, 'Copy it from the box above.'); } }));
        if (typeof navigator.share === 'function') acts.push(btn('Share…', 'btn', () => { navigator.share({ url: res.link }).catch(() => {}); }));
        const open = mk('a', 'btn', 'Open in Dropbox'); open.href = res.link; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.setAttribute('aria-label', 'Open in Dropbox (opens a new tab)'); open.title = 'Opens a new tab'; acts.push(open); // it says it opens a new tab (SHOULD 4)
    } else {
        f.body.append(mk('p', null, 'Shared. Open Settings to see it.'));
    }
    acts.push(btn('Stop sharing', 'btn', () => stopOne(f, res.id)));
    acts.push(btn('Done', 'btn', close));
    f.acts.replaceChildren(...acts);
    f.acts.querySelector('button')?.focus();
}

// sharesList is a file's live shares, each with its link (read again from Dropbox) and Stop sharing.
function sharesList(live, f) {
    const ul = mk('ul', 'dropbox-share-list');
    for (const s of live) {
        const li = mk('li');
        const exp = s.expires_at ? new Date(s.expires_at) : null;
        li.append(mk('b', null, String(s.name || 'A copy')), mk('span', 'settings-hint', ` · ${audienceWords[s.audience] || ''}${s.audience === 'people' ? ` (${Number(s.people || 0)})` : ''}${exp && !Number.isNaN(exp.getTime()) ? ' · expires ' + exp.toLocaleDateString() : ''}`));
        if (safeLink(s.link)) { const a = mk('a', null, 'Open in Dropbox'); a.href = s.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.setAttribute('aria-label', `Open ${String(s.name || 'this copy')} in Dropbox (opens a new tab)`); a.title = 'Opens a new tab'; li.append(' ', a); }
        if (s.sign_in_again) li.append(mk('span', 'settings-hint', ' · sign in to Dropbox again to see its link'));
        li.append(' ', btn('Stop sharing', 'btn btn-small', () => stopOne(f, s.id)));
        ul.append(li);
    }
    const wrap = mk('div'); wrap.append(mk('p', null, 'This file is shared through Dropbox:'), ul);
    return wrap;
}

async function stopOne(f, id) {
    sayIt(f.say, '');
    busy(true);
    const res = await call('POST', STOP + encodeURIComponent(String(id)), {});
    if (!f.body.isConnected) return;
    busy(false);
    if (res.status === 200) {
        f.body.replaceChildren(mk('p', null, 'Sharing stopped: the link no longer works and the copy was deleted from Dropbox.'));
        f.acts.replaceChildren(btn('Done', 'btn btn-primary', close));
        f.acts.querySelector('button')?.focus();
        return;
    }
    sayIt(f.say, String(res.body.error || 'Dropbox did not stop sharing it yet; its link may still work. Try again.'));
}

// signInAgain is an older Dropbox sign-in (it predates sharing): one way on, the existing Reconnect.
function signInAgain(f) {
    f.body.replaceChildren(mk('p', null, 'Dropbox does not allow this sign-in to share. In the Dropbox App Console, the Coral app needs the sharing.write and sharing.read permissions; then sign in to Dropbox again. Your backup keeps running meanwhile.'));
    const go = btn('Sign in again', 'btn btn-primary', async () => {
        busy(true);
        const res = await call('POST', '/api/dropbox/connect', {});
        if (!f.body.isConnected) return; // closed (or opened again) meanwhile: this answer is not the dialog's any more
        if (!f.body.isConnected) return;
    busy(false);
        const url = String(res.body.authorize_url || '');
        if (res.status !== 200 || !url.startsWith('https://www.dropbox.com/')) { sayIt(f.say, String(res.body.error || "Dropbox sign-in didn't start. Try again from Settings.")); return; }
        window.open(url, '_blank', 'noopener');
        f.body.replaceChildren(mk('p', null, 'Click Allow in the Dropbox tab, then share again.'));
        f.acts.replaceChildren(btn('Done', 'btn btn-primary', close));
    });
    f.acts.replaceChildren(btn('Cancel', 'btn', close), go);
    go.focus();
}
