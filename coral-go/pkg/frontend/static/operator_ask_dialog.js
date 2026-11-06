/* The question's reply box, pictures and offered actions; loaded when opened, not for the Inbox badge. */
import { LOCAL_SERVER, boardTeamKey } from './server_base.js';
import { openWithQuestionReturn } from './suspend_native_dialog.js';
import { markHidden } from './visible_marks.js';
import { renderMarkdownStrict } from './utils.js';
import { whenText } from './when_text.js';
import { loadStyles } from './lazy_styles.js';
import { showToast } from './notifications.js';
import { decisionNeedsPerson } from './server_base.js';
import { importOnce } from './import_once.js';
import { askParts, askSubjects, fromAnotherComputer, buttonsOf, yesNoButtons, buttonWords, claimButton, settleButton, wakeMember, refreshOperatorAsks, replyToAsk, forgetAsk } from './operator_asks.js';
await loadStyles('operator_ask_dialog.css');

const isReply = action => /^reply$/.test(action);

export function openAskDialog(a, onDone, runners = {}) {
    a = { ...a, server: a.server || LOCAL_SERVER }; // freeze the question's computer across navigation
    const dlg = document.createElement('dialog');
    dlg.className = 'modal-content dlg-flow inbox-ask-dialog'; // shared flow size on wide screens; narrow CSS keeps the form size and phone sheet
    dlg.setAttribute('aria-labelledby', 'inbox-ask-title');
    const parts = askParts(a);
    const title = document.createElement('h2'); title.id = 'inbox-ask-title'; title.textContent = parts.title;
    const sub = document.createElement('p'); sub.className = 'inbox-ask-sub';
    const who = markHidden(a.asker, { strict: true }); // the title and its link use the same visible name
    sub.textContent = whenText(a.at) + (a.kind === 'wait' ? ', waiting for your reply' : '');
    importOnce('./agent_link.js').then(m => { if (title.isConnected) title.replaceChildren(m.agentLink(who, { board: boardTeamKey(a.server, a.board) }), ` · ${markHidden(a.board_label || a.board || 'Team', { strict: true })}`); }); // the asker still opens their chat
    const subjects = askSubjects(a), links = document.createElement('p'); links.className = 'inbox-ask-subjects'; links.hidden = !subjects.length; if (subjects.length) loadStyles('pictures.css'); // its links are drawn by the lazy picture rules // the goal and task it is about, each a link that opens it in the Inbox
    if (subjects.length) links.append(document.createTextNode('About ')); // the asker names them: the line says so (Security's INFO on #12164)
    subjects.forEach((x, i) => {
        if (i) links.append(document.createTextNode(' \u00b7 '));
        const word = `${x.kind === 'goal' ? 'Goal' : 'Task'} #${x.id}`;
        if (!['goal', 'task'].includes(x.kind)) { const name = document.createElement('span'); name.textContent = word; name.title = `${word}${x.title ? `: ${x.title}` : ''} (named by ${who})`; links.append(name); return; }
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-quiet btn-small inbox-ask-subject'; b.textContent = word; b.dataset.kind = x.kind; b.title = `${word}${x.title ? `: ${x.title}` : ''} (named by ${who})`; b.setAttribute('aria-label', b.title);
        b.addEventListener('click', () => { openWithQuestionReturn(b, async () => { const nav = await importOnce('./nav.js'); await nav.go({ view: x.kind === 'goal' ? 'inbox-goals' : 'inbox-tasks', sub: x.kind === 'goal' ? 'goals' : 'tasks', id: boardTeamKey(a.server, a.board), item: Number(x.id) }); }).catch(e => { err.textContent = e.message || 'The item could not be opened.'; }); });
        links.append(b);
    });
    const whole = document.createElement('div'); whole.className = 'inbox-ask-text prose'; whole.setAttribute('role', 'region'); whole.setAttribute('aria-label', 'The question');
    whole.innerHTML = renderMarkdownStrict(parts.body + (a.cut ? '\n\n\u2026 (cut: the board has the rest)' : '')); // raw HTML in the words is written out as text; links keep the page's link policy
    importOnce('./artifact_refs.js').then(m => { if (whole.isConnected) m.linkArtifactRefsIn(whole, { asWritten: true, server: a.server }); }).catch(() => {}); // a file named in the question opens in the viewer, the words as written (#12361); plain text until the helper is there
    whole.hidden = !parts.body && !a.cut; // an empty question has no body
    const label = document.createElement('label'); label.className = 'inbox-ask-label'; label.textContent = 'Your reply';
    const box = document.createElement('textarea'); box.className = 'field inbox-ask-box'; box.rows = 6; box.placeholder = 'Write a reply…'; box.maxLength = 8000; label.append(box);
    box.addEventListener('input', () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`; });
    const pics = document.createElement('div'); pics.className = 'inbox-ask-pics'; // pictures for the reply (#12173): the comment composer's tray, loaded with the dialog
    const err = document.createElement('p'); err.className = 'inbox-ask-error'; err.setAttribute('role', 'alert');
    const row = document.createElement('div'); row.className = 'inbox-ask-buttons';
    const send = document.createElement('button'); send.type = 'button'; send.className = 'btn btn-primary inbox-ask-send'; send.textContent = 'Send reply';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.textContent = 'Close';
    // Dismiss closes a question with no answer and nothing said to the agent, as the row's own Dismiss does (#12599): the same route and the same toast with Undo. A wait has no ask row to close, so it has no Dismiss.
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'btn btn-quiet'; dismiss.textContent = 'Dismiss'; dismiss.title = 'Take it out of Needs you; nobody is told'; dismiss.hidden = a.kind !== 'ask' || fromAnotherComputer(a); // the close route is this computer's: a question from another computer is answered there
    row.append(close, ...(dismiss.hidden ? [] : [dismiss])); // Close and Dismiss stay in the footer; Send reply is on the row right under the reply box (#13148, the Operator: 'The send reply is too far away from text input')
    let tray = null;
    const finish = () => { if (tray) tray.destroy(); dlg.close(); dlg.remove(); if (onDone) onDone(); };
    let sending = false; const choices = [];
    const picturesBlocked = () => !!tray && (tray.busy() || tray.failed());
    const replyText = () => [box.value.trim(), tray ? tray.hexes().map(h => `coral://artifacts/${h}`).join('\n') : ''].filter(Boolean).join('\n\n');
    const sync = () => { send.disabled = sending || picturesBlocked(); choices.forEach(c => { c.disabled = sending || (binary && picturesBlocked()); }); }; // Send waits for a picture going up, and for a failed one to be taken out
    const binary = yesNoButtons(a);
    const offers = (fromAnotherComputer(a) && (!binary || decisionNeedsPerson(a.server))) ? [] : buttonsOf(a); // remote binary replies use the owner-stamped claim route; other remote actions keep Reply and Close
    let offered = null;
    if (offers.length) { // what the asker offered: one tap per choice, each with what it does
        offered = document.createElement('section'); offered.className = 'inbox-ask-offers'; offered.setAttribute('aria-label', `Buttons ${markHidden(a.asker, { strict: true })} offered`);
        const head = document.createElement('p'); head.className = 'inbox-ask-offers-head'; head.textContent = offers.every(b => isReply(b.action)) ? 'Choose a reply, or write your own.' : 'Choose an action, or write a reply.';
        const list = document.createElement('div'); list.className = 'inbox-ask-offers-list';
        for (const b of offers) {
            const item = document.createElement('div'); item.className = 'inbox-ask-offer';
            const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn'; const label = binary ? (b.label === 'Yes' ? 'Approve' : 'Deny') : markHidden(b.label, { strict: true }); btn.textContent = label; btn.dataset.buttonId = String(b.id);
            const what = document.createElement('span'); what.className = 'inbox-ask-offer-what sr-only'; what.textContent = buttonWords(b);
            btn.setAttribute('aria-label', `${label}: ${what.textContent}`); btn.title = what.textContent;
            if (binary) { const icon = document.createElement('span'); icon.className = 'material-icons'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = b.label === 'Yes' ? 'check' : 'close'; btn.replaceChildren(icon); btn.classList.add('btn-icon'); btn.setAttribute('aria-label', `${label}, sends ${b.label} with any draft text and pictures`); btn.title = btn.getAttribute('aria-label'); }
            btn.addEventListener('click', async () => {
                if (sending || (binary && picturesBlocked())) return;
                sending = true; err.textContent = ''; sync();
                try {
                    const draft = replyText();
                    if (binary && draft) { await replyToAsk(a, `${b.label}\n\n${draft}`); finish(); showToast(`Sent: ${b.label} with your reply`); return; }
                    const got = await claimButton(a, b); // the stored action, whatever the label says
                    if (isReply(got.action)) { forgetAsk(a); refreshOperatorAsks(true); finish(); showToast(`Sent: ${markHidden(got.label, { strict: true })}`); return; }
                    const navigates = ['open:new-agent', 'open:task', 'open:artifact'].includes(got.action);
                    finish(); // the dialog is modal: it goes before the page it opens
                    try {
                        if (got.action === 'open:new-agent') { if (!window.showLaunchModal) throw new Error('The New agent dialog is not available here.'); await window.showLaunchModal(); }
                        else if (got.action === 'open:task') { if (!runners.task) throw new Error('Tasks cannot be opened here.'); await runners.task(a, String(got.arg)); }
                        else if (got.action === 'open:artifact') { if (!runners.artifact) throw new Error('Files cannot be opened here.'); await runners.artifact(a, String(got.arg)); }
                        else if (got.action === 'wake') { await wakeMember(a, String(got.arg)); showToast(`Woke ${markHidden(got.arg, { strict: true })}.`); }
                        else throw new Error('This button does something this version does not know.');
                        if (!navigates) await settleButton(a, b, 'done'); // only an action that answers the question settles it
                    } catch (e) {
                        showToast(e.message || 'That did not work.', true);
                        if (!navigates) await settleButton(a, b, 'failed').catch(() => {}); // give a failed wake back; navigation never claims an answer
                    }
                    refreshOperatorAsks(true);
                } catch (e) { err.textContent = e.message || 'Not done.'; sending = false; sync(); }
            });
            choices.push(btn); item.append(btn, what); list.append(item);
        }
        const hint = document.createElement('p'); hint.className = 'inbox-ask-offers-hint'; hint.textContent = binary ? 'Sends Yes or No with any text and pictures below.' : offers.every(b => isReply(b.action)) ? 'Replies are sent as you.' : 'These actions run as you when you choose one.';
        offered.append(head, list, hint);
    }
    const foot = document.createElement('div'); foot.className = 'inbox-ask-foot'; foot.append(row); // Reply attachments belong with the reply box; the footer holds its final actions
    const reading = document.createElement('div'); reading.className = 'inbox-ask-reading'; reading.tabIndex = -1;
    if (!whole.hidden) reading.append(whole);
    if (offered && !binary) reading.append(offered);
    const compose = document.createElement('div'); compose.className = 'inbox-ask-compose';
    const addSlot = document.createElement('div'); addSlot.className = 'inbox-ask-attach'; pics.append(addSlot);
    const sendRow = document.createElement('div'); sendRow.className = 'inbox-ask-sendrow'; const pickSlot = document.createElement('span'); pickSlot.className = 'inbox-ask-pick'; sendRow.append(pickSlot, send); addSlot.append(sendRow); // Add image on the left, Send reply on the right, the pictures note under them (#13148)
    if (offered && binary) { offered.classList.add('inbox-ask-yes-no'); offered.replaceChildren(offered.querySelector('.inbox-ask-offers-list')); sendRow.insertBefore(offered, send); }
    compose.append(label, pics, err);
    dlg.append(title, sub, ...(links.hidden ? [] : [links]), reading, compose, foot);
    if (!fromAnotherComputer(a)) { // the picture is stored on the question's own team, as a goal's pictures are
        Promise.all([importOnce('./artifact_comment_images.js'), importOnce('./artifact_comments_api.js')]).then(([m, api]) => {
            if (!dlg.isConnected) return;
            tray = m.createImageTray({ upload: (blob, versionOf) => api.uploadCommentImage(null, a.server, blob, versionOf, a.board) });
            tray.attach(dlg, box); tray.listen(sync);
            const picker = tray.picker(), add = picker.querySelector('button');
            add.textContent = ''; const icon = document.createElement('span'); icon.className = 'material-icons'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = 'image'; add.append(icon); add.title = 'Add image';
            pickSlot.append(picker); addSlot.append(tray.hint()); pics.append(tray.node);
        }).catch(() => { /* a reply needs no picture: the dialog works without the button */ });
    }
    close.addEventListener('click', finish);
    dismiss.addEventListener('click', async () => {
        if (sending) return;
        sending = true; err.textContent = ''; dismiss.disabled = true; sync();
        try { const m = await importOnce('./ask_ignore.js'); await m.ignoreAsk(a, markHidden(a.asker, { strict: true })); forgetAsk(a); finish(); }
        catch (e) { err.textContent = e.message || 'Could not dismiss it.'; dismiss.disabled = false; sending = false; sync(); }
    });
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !send.disabled) { e.preventDefault(); send.click(); } }); // Ctrl or Cmd+Enter sends, as the task page's reply box does (#13148)
    send.addEventListener('click', async () => {
        if (sending || picturesBlocked()) return;
        sending = true; err.textContent = ''; sync();
        try { await replyToAsk(a, replyText()); finish(); }
        catch (e) { err.textContent = e.message || 'Not sent.'; sending = false; sync(); box.focus(); } // the text stays
    });
    document.body.append(dlg);
    dlg.showModal();
    box.focus();
    return dlg;
}
