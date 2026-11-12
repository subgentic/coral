/* A file decision in Activity opens in a dialog like the one for an answered question (#15792, the Operator's mockup v3): what was decided and when, one comment box that takes pictures (Attach image, paste, drop), and the
 * buttons at the right: Copy link, Reopen for review (the file goes back to Needs you waiting for a decision: a new round, the file's own Send for review) and Open file (the viewer). Lazy: loaded by the Activity folder when a
 * file's row is opened. A file's name and the words with it are an agent's, written as text. */
import { splitKey, decisionNeedsPerson } from './server_base.js';
import { importOnce } from './import_once.js';
import { copyText, showToast } from './utils.js';
import { markHidden } from './visible_marks.js';
import { whenText } from './when_text.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('activity_dialog.css');
const { createComment, uploadCommentImage } = await importOnce('./artifact_comments_api.js'); // lazy modules load the others through importOnce (import_hygiene)
const { createImageTray } = await importOnce('./artifact_comment_images.js');
const { sendForReview } = await importOnce('./artifact_send_review.js');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const DECIDED = { approve: 'Approved', changes: 'Asked for changes', deny: 'Denied', ignore: 'Dismissed', save: 'Saved', unsave: 'Moved back', supersede: 'Superseded' };

/** Open the dialog of a file's row: `row` is the record's row (version or item_id is the file's digest, team the board, title its name). `openFile(row)` opens the viewer; `onDone` runs when the dialog closes. */
export function openFileDecision(row, { openFile, onDone } = {}) {
    const hex = String(row.version || row.item_id || '').toLowerCase();
    const { server, name: board } = splitKey(row.team);
    const dlg = el('dialog', 'modal-content dlg-flow activity-thread-dialog activity-file-dialog'); dlg.setAttribute('aria-labelledby', 'activity-file-title');
    const icon = el('span', 'activity-kind activity-kind-code', '</>'); icon.setAttribute('aria-hidden', 'true');
    const title = el('h2', null, ''); title.id = 'activity-file-title'; title.append(el('span', 'activity-thread-state', DECIDED[row.action] || 'Decided'));
    const who = row.asker ? `from ${markHidden(row.asker, { strict: true })}` : '';
    const sub = el('p', 'activity-thread-sub', [board, who, `decided ${whenText(row.at)}`].filter(Boolean).join(' · '));
    const names = el('div', 'activity-thread-names'); names.append(title, sub);
    const head = el('div', 'activity-thread-headrow'); head.append(icon, names);
    const item = el('div', 'activity-file-line'); item.append(el('b', 'activity-file-name', markHidden(row.title || 'a file', { strict: true })), ...(row.version ? [el('span', 'activity-file-version', ' version')] : []));
    const said = el('p', 'activity-file-said', row.note ? String(row.note) : '');
    // one comment box (Comment and Send reply are one box in v3): a note for the team on this file, with pictures
    const label = el('label', 'activity-thread-label', 'Comment on this file'); const box = el('textarea', 'field activity-thread-box'); box.rows = 3; box.maxLength = 8000; box.placeholder = 'Comment on this file…'; label.append(box);
    const tray = createImageTray({ upload: (blob, versionOf) => uploadCommentImage(hex, server, blob, versionOf, board) });
    const err = el('p', 'activity-thread-error'); err.setAttribute('role', 'alert');
    const copy = el('button', 'btn btn-small', 'Copy link'); copy.type = 'button';
    const reopen = el('button', 'btn btn-small activity-file-reopen', 'Reopen for review'); reopen.type = 'button'; reopen.hidden = decisionNeedsPerson(server);
    const open = el('button', 'btn btn-primary', 'Open file'); open.type = 'button';
    const post = el('button', 'btn btn-small activity-file-comment', 'Send comment'); post.type = 'button'; post.disabled = true;
    const close = el('button', 'btn btn-small', 'Close'); close.type = 'button';
    const actions = el('div', 'activity-thread-actions'); actions.append(copy, reopen, close, post, open);
    const sync = () => { post.disabled = !(box.value.trim() || tray.hexes().length) || tray.busy() || tray.failed(); };
    box.addEventListener('input', () => { err.textContent = ''; sync(); }); tray.listen(sync);
    const pick = tray.picker(), add = pick.querySelector('.ac-add-image'); if (add) add.textContent = 'Attach image'; // the mockup's word
    const attachRow = el('div', 'activity-thread-attach'); attachRow.append(pick, el('span', 'activity-thread-hint', 'Paste or drop an image here too'));
    dlg.append(head, item, said, label, attachRow, tray.node, tray.hint(), err, actions); document.body.append(dlg);
    tray.attach(dlg, box);
    const opener = document.activeElement;
    const finish = () => { tray.destroy(); dlg.close(); dlg.remove(); if (onDone) onDone(); if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true }); };
    close.addEventListener('click', finish); dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    copy.addEventListener('click', async () => { if (await copyText(`coral://artifacts/${hex}`)) showToast('Link copied.'); else showToast('Could not copy the link.', true); });
    open.addEventListener('click', () => { finish(); if (openFile) openFile(row); });
    reopen.addEventListener('click', async () => {
        reopen.disabled = true; err.textContent = '';
        try { await sendForReview(board, hex); showToast('The file is back in Needs you, waiting for a decision.'); finish(); }
        catch (e) { err.textContent = e.message || 'Could not send the file for review.'; reopen.disabled = false; }
    });
    post.addEventListener('click', async () => {
        post.disabled = true; err.textContent = '';
        try {
            await createComment(hex, server, { body: box.value.trim(), anchor: { whole: true }, board, images: tray.hexes() });
            box.value = ''; tray.clear(); showToast('Comment sent to the team.'); sync();
        } catch (e) { err.textContent = e.message || 'The comment was not sent.'; sync(); }
    });
    dlg.showModal(); box.focus({ preventScroll: true });
    return dlg;
}
