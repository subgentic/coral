/* An answered question in Activity opens as a thread (#15724, the Operator's pick: design B's timeline, one block per message with a name and a time): the agent's question, the Operator's answer and every later reply
 * in order, then a box to reply into the same thread and the way to the Board. Lazy: loaded by the Activity folder when a question's row is opened. A message's words are the agent's, so they are written as text
 * (renderMarkdownStrict writes raw HTML out as text), never inserted as markup. */
import { boardFetch, splitKey, sessionTeamKey } from './server_base.js';
import { fetchMessages } from './board_fetch.js';
import { OPERATOR_ID, renderMarkdownStrict, showToast } from './utils.js';
import { markHidden } from './visible_marks.js';
import { whenText } from './when_text.js';
import { loadStyles } from './lazy_styles.js';
import { state } from './state.js';
import { prepareImage } from './image_attach.js';
import { postImage } from './image_composer.js';
import { attachmentsLead } from './shared_images.js';
await loadStyles('activity_dialog.css');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The messages of the question's thread, in order: the question, then each message that answers one already in it (a reply to an answer is in too). A pure function of the board's messages after the question. */
export function threadOf(messages, askId) {
    const ids = new Set([askId]), out = [];
    for (const m of [...messages].sort((a, b) => a.id - b.id)) {
        if (m.id === askId || (m.reply_to && ids.has(Number(m.reply_to)))) { ids.add(m.id); out.push(m); }
    }
    return out;
}
const mine = m => m.subscriber_id === OPERATOR_ID || m.subscriber_id === 'dashboard';
const nameOf = m => mine(m) ? 'You' : markHidden(m.subscriber_id || 'Agent', { strict: true });

function block(m) {
    const b = el('li', `activity-thread-msg${mine(m) ? ' activity-thread-mine' : ''}`); b.dataset.messageId = String(m.id);
    const head = el('div', 'activity-thread-head'); head.append(el('strong', 'activity-thread-name', nameOf(m)), el('span', 'activity-thread-time', whenText(m.created_at)));
    const body = el('div', 'activity-thread-body prose'); body.innerHTML = renderMarkdownStrict(String(m.content || ''));
    b.append(head, body); return b;
}

/** Open the thread of an answered question: `row` is the record's row (item_id is the question's message, team the board). `onDone` runs when the dialog closes. */
export async function openThread(row, { onDone, openBoard, openTask } = {}) {
    const team = row.team, askId = Number(row.item_id), asker = row.asker || row.title || 'the agent';
    const dlg = el('dialog', 'modal-content dlg-flow activity-thread-dialog'); dlg.setAttribute('aria-labelledby', 'activity-thread-title');
    const head = el('div', 'activity-thread-headrow');
    const title = el('h2', null, ''); title.id = 'activity-thread-title';
    const icon = el('span', 'activity-kind activity-kind-ask', '?'); icon.setAttribute('aria-hidden', 'true');
    const chip = el('span', 'activity-thread-state', row.action === 'answer' ? 'Answered' : 'Question'); title.append(chip);
    const sub = el('p', 'activity-thread-sub', [splitKey(team).name, `from ${markHidden(asker, { strict: true })}`, `decided ${whenText(row.at)}`].join(' · '));
    const names = el('div', 'activity-thread-names'); names.append(title, sub); head.append(icon, names);
    const list = el('ol', 'activity-thread'); list.setAttribute('aria-label', 'The thread');
    const status = el('p', 'activity-thread-status', 'Reading the thread…'); status.setAttribute('role', 'status');
    // One Reply box (the Operator's pick: Comment and Send reply merged): the reply goes to the agent, in this thread; images go in with the Attach image button, a paste or a drop.
    const label = el('label', 'activity-thread-label', `Reply to ${markHidden(asker, { strict: true })}`); const box = el('textarea', 'field activity-thread-box'); box.rows = 3; box.maxLength = 8000; box.placeholder = `Reply to ${asker}…`; label.append(box);
    const pics = []; let uploading = 0; // { path, filename, artifact, previewUrl }
    const strip = el('div', 'activity-thread-pics'); strip.hidden = true;
    // 'image/' + '*' is written in two parts: a slash-star in a string reads as the start of a comment to the page's lint
    const picker = el('input'); picker.type = 'file'; picker.accept = 'image/' + '*'; picker.multiple = true; picker.hidden = true;
    const attach = el('button', 'btn btn-small', 'Attach image'); attach.type = 'button';
    const hint = el('span', 'activity-thread-hint', 'Paste or drop an image here too');
    const attachRow = el('div', 'activity-thread-attach'); attachRow.append(attach, hint, picker);
    const err = el('p', 'activity-thread-error'); err.setAttribute('role', 'alert');
    const send = el('button', 'btn btn-primary activity-thread-send', 'Send reply'); send.type = 'button'; send.disabled = true;
    const board = el('button', 'btn btn-small activity-thread-board', 'Open on the Board'); board.type = 'button'; board.hidden = typeof openBoard !== 'function';
    const task = el('button', 'btn btn-small activity-thread-task', `Open task #${row.task_id || ''}`); task.type = 'button'; task.hidden = !(row.task_id && typeof openTask === 'function');
    const close = el('button', 'btn btn-small', 'Close'); close.type = 'button';
    const actions = el('div', 'activity-thread-actions'); actions.append(task, board, close, send);
    const canSend = () => (box.value.trim() || pics.length) && !uploading;
    const drawPics = () => { strip.hidden = !pics.length && !uploading; strip.replaceChildren(...pics.map((a, i) => { const w = el('div', 'image-attachment'); const im = el('img'); im.src = a.previewUrl; im.alt = `Image ${i + 1}`; const x = el('button', 'image-attachment-remove', '\u00d7'); x.type = 'button'; x.setAttribute('aria-label', `Remove image ${i + 1}`); x.addEventListener('click', () => { URL.revokeObjectURL(a.previewUrl); pics.splice(i, 1); drawPics(); }); w.append(im, x); return w; }), ...(uploading ? [Object.assign(el('div', 'image-uploading', `Uploading ${uploading === 1 ? 'image' : uploading + ' images'}\u2026`), {})] : [])); send.disabled = !canSend(); };
    // An image goes up to the asking agent's own computer the way the message box's does (one uploader, postImage): it needs that agent to be running.
    const agentSession = () => (state.liveSessions || []).find(x => [x.display_name, x.name].includes(asker) && sessionTeamKey(x) === team) || null; // the agent of THIS team on THIS computer: another team's agent of the same name is not the one asked
    const addImages = async files => {
        const session = agentSession();
        if (!session) { showToast(`${asker} is not running, so an image cannot be sent to it now.`, true); return; }
        for (const file of files) {
            const prepared = await prepareImage(file); if (prepared.error) { showToast(prepared.error, true); continue; }
            uploading++; drawPics();
            let result = null; try { result = await postImage(prepared.file, session, () => addImages([file])); } finally { uploading--; }
            if (result) pics.push({ path: result.path, filename: result.filename, artifact: result.artifact || null, previewUrl: URL.createObjectURL(prepared.file) });
            drawPics();
        }
    };
    attach.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { const f = [...(picker.files || [])]; picker.value = ''; if (f.length) addImages(f); });
    box.addEventListener('paste', e => { const f = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean); if (!f.length) return; e.preventDefault(); addImages(f); });
    dlg.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    dlg.addEventListener('drop', e => { const f = [...(e.dataTransfer?.files || [])].filter(x => x.type.startsWith('image/')); if (!f.length) return; e.preventDefault(); addImages(f); });
    dlg.append(head, status, list, label, strip, attachRow, err, actions); document.body.append(dlg);
    const opener = document.activeElement;
    const finish = () => { dlg.close(); dlg.remove(); if (onDone) onDone(); if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true }); };
    close.addEventListener('click', finish); dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    board.addEventListener('click', () => { finish(); openBoard(row); });
    task.addEventListener('click', () => { finish(); openTask(row); });
    let thread = [], kept = false; // kept: the record's own words stand in for a thread the board no longer has
    const paint = () => { list.replaceChildren(...thread.map(block)); status.hidden = true; send.disabled = !canSend(); };
    box.addEventListener('input', () => { send.disabled = !canSend(); err.textContent = ''; });
    send.addEventListener('click', async () => {
        const text = [...attachmentsLead(pics), box.value.trim()].filter(Boolean).join('\n\n'); if (!text) return;
        const parent = thread.length && !kept ? thread[thread.length - 1] : { id: askId, subscriber_id: asker };
        send.disabled = true; err.textContent = '';
        try {
            const resp = await boardFetch(team, '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, as: 'Operator', content: `@${asker} ${text}`, reply_to: parent.id }) });
            if (!resp.ok) { let why = ''; try { const b = await resp.json(); if (b && typeof b.error === 'string') why = b.error; } catch { /* not JSON */ } throw new Error(why ? `Not sent: ${why}` : `Not sent (HTTP ${resp.status}).`); }
            const made = await resp.json().catch(() => ({}));
            thread = [...thread, { id: Number(made.id) || parent.id + 1, subscriber_id: OPERATOR_ID, content: `@${asker} ${text}`, created_at: new Date().toISOString(), reply_to: parent.id }];
            box.value = ''; for (const a of pics.splice(0)) URL.revokeObjectURL(a.previewUrl); drawPics(); paint(); list.lastElementChild?.scrollIntoView({ block: 'nearest' }); showToast('Reply sent.');
        } catch (e) { err.textContent = e.message || 'Not sent.'; send.disabled = false; } // the draft stays
    });
    dlg.showModal(); box.focus({ preventScroll: true });
    try {
        const { messages } = await fetchMessages(team, 200, { after_id: Math.max(0, askId - 1) });
        thread = threadOf(messages, askId);
    } catch { thread = []; }
    if (!thread.length) { kept = true; // the board no longer has it: the record's own words say what was asked and answered
        thread = [{ id: askId, subscriber_id: asker, content: row.title || '', created_at: row.at }, ...(row.note ? [{ id: askId + 1, subscriber_id: OPERATOR_ID, content: String(row.note).replace(/^Your answer: /, ''), created_at: row.at }] : [])];
        status.hidden = false; status.textContent = 'The board has no longer got this thread; this is what the record kept.';
        list.replaceChildren(...thread.map(block)); send.disabled = !canSend(); return dlg;
    }
    paint(); return dlg;
}
