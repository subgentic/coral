/* Questions to the Operator in their Needs you (#11417). An agent asks the Operator with `coral-board post --ask "@Operator ..."` or `coral-board wait --operator "..."`; neither was in the Inbox, which is
 * built from the live list, so the person did not see what they were asked. GET /api/operator-asks lists both for every board (the whole question as text); a row of Needs you says who asks and the question
 * on one line, and opens whole in a dialog with a Reply box. The reply is the board post the dashboard already makes (POST /api/board/{board}/messages as the Operator, with the asker's @name, and reply_to
 * for an ask): it answers the ask, ends a wait, and tells the asker by the post itself. The text is the agent's, so it is written out through markHidden (strict) before it is drawn, then cut. */
import { markHidden } from './visible_marks.js';
import { OPERATOR_ID, renderMarkdownStrict } from './utils.js';
import { whenText } from './when_text.js';
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { showToast } from './notifications.js';
import { isCloud, isLocalServer } from './server_base.js';

const FRESH_MS = 15000, LINE_MAX = 140;
let asks = [], pending = null, lastRead = 0;
const listeners = new Set();
/** The open questions, oldest first. */
export const operatorAsks = () => asks;
/** Called after a read that changed the list. Returns the way to stop. */
export const onOperatorAsksChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const fire = () => { for (const f of listeners) f(); };

/** The words without their Markdown marks, for a plain-text preview (a row's lines, #12152): emphasis, code, headings, quotes, bullets, links and images become their words; nothing else is touched. */
export function plainMarkdown(text) {
    return String(text == null ? '' : text).split('\n').map(l => l
        .replace(/^\s*```.*$/, '').replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*[-*+]\s+/, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1').replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2').replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
        .replace(/(^|[\s(])\*(?=\S)(.+?)(?<=\S)\*(?=[\s).,;:!?]|$)/g, '$1$2').replace(/(^|[\s(])_(?=\S)(.+?)(?<=\S)_(?=[\s).,;:!?]|$)/g, '$1$2')).join('\n');
}
/** A question as one line of a row: hidden characters written out, Markdown marks dropped, white space collapsed, cut after marking so a mark is never split. */
export function askLine(a) {
    const one = plainMarkdown(markHidden(a && a.text, { strict: true })).replace(/\s+/g, ' ').trim();
    return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1).trimEnd()}…` : one;
}
/** The whole question, hidden characters written out, line breaks kept. */
export const askWhole = a => markHidden(a && a.text, { strict: true });
/** The whole question as plain text (a row's second line): the same words, line breaks kept, without the Markdown marks. */
export const askPlain = a => plainMarkdown(askWhole(a));
/** A stable id of one question among the rows. */
export const askKey = a => `operator-ask:${a.board}:${a.kind}:${a.id}`;

/** Read the list (at most once in 15 s unless forced; one read at a time). Safe to call after every live update. */
export function refreshOperatorAsks(force = false) {
    if (pending) return pending;
    if (!force && Date.now() - lastRead < FRESH_MS) return null;
    lastRead = Date.now();
    pending = fetch('/api/operator-asks').then(r => (r.ok ? r.json() : null)).then(rows => {
        if (!Array.isArray(rows)) return; // refused or failed: what is drawn stays (a viewer who may not read it has none)
        const next = rows.filter(a => a && typeof a.board === 'string' && typeof a.asker === 'string' && Number.isFinite(Number(a.id)));
        if (JSON.stringify(next) === JSON.stringify(asks)) return;
        asks = next;
        fire();
    }).catch(() => {}).finally(() => { pending = null; });
    return pending;
}

/** Post the reply as the Operator. An ask is answered with reply_to; either way the asker is @named so the board tells it. Rejects with the server's words when the post is refused. */
export async function replyToAsk(a, text) {
    const body = String(text || '').trim();
    if (!body) throw new Error('Write a reply first.');
    const content = `@${a.asker} ${body}`;
    const resp = await fetch(`/api/board/${encodeURIComponent(a.board)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriber_id: OPERATOR_ID, as: 'Operator', content, ...(a.kind === 'ask' ? { reply_to: a.id } : {}) }),
    });
    if (!resp.ok) {
        let why = '';
        try { const b = await resp.json(); if (b && typeof b.error === 'string') why = b.error; } catch { /* not JSON */ }
        throw new Error(why ? `Not sent: ${why}` : `Not sent (HTTP ${resp.status}).`);
    }
    asks = asks.filter(x => askKey(x) !== askKey(a)); // gone at once; the next read confirms it
    fire();
    refreshOperatorAsks(true);
}

// ── Buttons an agent put on a question (#11445, #11643) ─────────────────────────────────────────────────
// The agent DECLARES up to three buttons; nothing runs until the Operator clicks one here. The label is the agent's text, so it is drawn with textContent after markHidden (strict), and the ACTION is named in
// our own words beside it, so a label like "Cancel" cannot hide that it wakes an agent. A click claims the button on the server, which answers with the STORED action: the page runs only that, never anything it
// holds itself. A reply is run by the server (posted as the Operator, said to be a click, the question closed); open and wake run here through the routes the dashboard already uses, then the page settles.

/** Whether the question came from another computer, or the page is the Hub's (#11757, Security's INFO on #11643): the claim and settle routes are not served through Coral Hub, so a button there would only fail with an error. */
export const fromAnotherComputer = a => isCloud() || (!!a && typeof a.server === 'string' && a.server !== '' && !isLocalServer(a.server));

/** The buttons of a question that can still be used: only a question (not a wait) has them, and a used one is gone. */
export const buttonsOf = a => (a && a.kind === 'ask' && Array.isArray(a.buttons) ? a.buttons.filter(b => b && b.state === 'pending' && Number.isFinite(Number(b.id)) && typeof b.label === 'string' && typeof b.action === 'string') : []);

// The reply action is tested as a pattern, not a quoted word: tests/frontend/icon_names.mjs reads every quoted word that is a Material icon's name as an icon the font must hold, and reply is one.
const isReply = action => /^reply$/.test(action);

/** What a click does, in the app's own words (never the agent's). */
export function buttonWords(b) {
    if (isReply(b.action)) return `Replies "${markHidden(b.label, { strict: true })}" as you`;
    switch (b.action) {
        case 'open:new-agent': return 'Opens the New agent dialog';
        case 'open:task': return `Opens task #${Number(b.arg) || '?'}`;
        case 'open:artifact': return 'Opens a file';
        case 'wake': return `Wakes ${markHidden(b.arg, { strict: true })}`;
        default: return 'Does something this version does not know';
    }
}

const buttonUrl = (a, b, verb) => `/api/board/${encodeURIComponent(a.board)}/asks/${encodeURIComponent(a.id)}/buttons/${encodeURIComponent(b.id)}/${verb}`;
async function buttonCall(a, b, verb, body) {
    const resp = await fetch(buttonUrl(a, b, verb), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let data = null; try { data = await resp.json(); } catch { /* no body */ }
    if (!resp.ok) throw new Error((data && (data.message || data.error)) || `Not done (HTTP ${resp.status}).`);
    return data || {};
}
/** Claim the button: the server answers with its stored action, argument and label. */
export const claimButton = (a, b) => buttonCall(a, b, 'claim');
/** Tell the server what became of an open or wake the page ran: done closes the question, failed gives the button back. */
export const settleButton = (a, b, outcome) => buttonCall(a, b, 'settle', { outcome });

/** Wake the member the button names: a sleeping agent of this Coral, through the route the dashboard's own Wake uses. The member is found on the question's own board (its subscriber, whose session name is
 * "<cli>-<session id>"), never by name alone across teams. Rejects in words when there is nothing to wake. */
export async function wakeMember(a, name) {
    const who = markHidden(name, { strict: true });
    const r = await fetch(`/api/board/${encodeURIComponent(a.board)}/subscribers`);
    const subs = r.ok ? await r.json().catch(() => []) : [];
    const sub = (Array.isArray(subs) ? subs : []).find(x => x && x.subscriber_id === name);
    if (!sub || !sub.session_name) throw new Error(`${who} is not a member of this team that Coral can wake.`);
    const live = (state.liveSessions || []).find(s => `${s.agent_type}-${s.session_id}` === sub.session_name);
    if (!live) throw new Error(`${who} is not running on this computer.`);
    if (!live.sleeping) throw new Error(`${who} is not asleep.`);
    const resp = await fetch(`/api/sessions/live/${encodeURIComponent(live.session_id)}/wake`, { method: 'POST' });
    if (!resp.ok) throw new Error(`Could not wake ${who} (HTTP ${resp.status}).`);
}

/** A question the way a review item reads (#12143, the operator): a short subject for the title (the first line when it is short, else the first words), who asked, on which team and when under it, the words as rendered Markdown with the
 * "@Operator" the asker opened with taken off, and the reply in the item. The body keeps everything the question says: when the first line became the title, the body is the rest; a one-line question has no body. */
export function askParts(a) {
    const clean = askWhole(a).replace(/^\s*@Operator\b[:,]?\s*/i, '').trim();
    const lines = clean.split('\n'), first = (lines[0] || '').trim().replace(/^#{1,6}\s+/, '');
    if (first.length <= 80) return { title: first.replace(/[*_`]/g, '') || 'A question', body: lines.slice(1).join('\n').trim() };
    const cut = first.slice(0, 80), at = cut.lastIndexOf(' ');
    return { title: `${(at > 40 ? cut.slice(0, at) : cut).replace(/[*_`]/g, '').replace(/[\s,;:.-]+$/, '')}\u2026`, body: clean };
}

/** The question whole, with a Reply box: a modal dialog (focus kept inside it, Escape closes it). */
export function openAskDialog(a, onDone, runners = {}) {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal-content dlg-form inbox-ask-dialog'; // the shared dialog rule sizes it (--dlg-max, dlg-form), not a width of its own
    dlg.setAttribute('aria-labelledby', 'inbox-ask-title');
    const parts = askParts(a);
    const title = document.createElement('h2'); title.id = 'inbox-ask-title'; title.textContent = parts.title;
    const sub = document.createElement('p'); sub.className = 'inbox-ask-sub';
    sub.textContent = [`From ${markHidden(a.asker, { strict: true })}`, (/\bteam$/i.test(a.board_label || a.board) ? (a.board_label || a.board) : `${a.board_label || a.board} team`), whenText(a.at)].filter(Boolean).join(' \u00b7 ') + (a.kind === 'wait' ? ', waiting for your reply' : '');
    const whole = document.createElement('div'); whole.className = 'inbox-ask-text prose'; whole.tabIndex = 0; whole.setAttribute('role', 'region'); whole.setAttribute('aria-label', 'The question');
    whole.innerHTML = renderMarkdownStrict(parts.body + (a.cut ? '\n\n\u2026 (cut: the board has the rest)' : '')); // raw HTML in the words is written out as text; links keep the page's link policy
    whole.hidden = !parts.body && !a.cut; // a short question is its title
    const label = document.createElement('label'); label.className = 'inbox-ask-label'; label.textContent = 'Your reply';
    const box = document.createElement('textarea'); box.className = 'field inbox-ask-box'; box.rows = 4; box.maxLength = 8000; label.append(box);
    const pics = document.createElement('div'); pics.className = 'inbox-ask-pics'; // pictures for the reply (#12173): the comment composer's tray, loaded with the dialog
    const err = document.createElement('p'); err.className = 'inbox-ask-error'; err.setAttribute('role', 'alert');
    const row = document.createElement('div'); row.className = 'inbox-ask-buttons';
    const send = document.createElement('button'); send.type = 'button'; send.className = 'btn btn-primary'; send.textContent = 'Send reply';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.textContent = 'Close';
    row.append(close, send); // Close on the left, Send reply on the right (as the other dialogs)
    let tray = null;
    const finish = () => { if (tray) tray.destroy(); dlg.close(); dlg.remove(); if (onDone) onDone(); };
    const sync = () => { send.disabled = !!tray && (tray.busy() || tray.failed()); }; // Send waits for a picture going up, and for a failed one to be taken out
    const offers = fromAnotherComputer(a) ? [] : buttonsOf(a); // a question from another computer through the Hub keeps the plain Reply and Close
    let offered = null;
    if (offers.length) { // what the asker offered: one tap per choice, each with what it does
        offered = document.createElement('section'); offered.className = 'inbox-ask-offers'; offered.setAttribute('aria-label', `Buttons ${markHidden(a.asker, { strict: true })} offered`);
        const head = document.createElement('p'); head.className = 'inbox-ask-offers-head'; head.textContent = `${markHidden(a.asker, { strict: true })} offered these. Nothing runs until you tap one.`;
        const list = document.createElement('div'); list.className = 'inbox-ask-offers-list';
        const choices = [];
        for (const b of offers) {
            const item = document.createElement('div'); item.className = 'inbox-ask-offer';
            const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn'; btn.textContent = markHidden(b.label, { strict: true }); btn.dataset.buttonId = String(b.id);
            const what = document.createElement('span'); what.className = 'inbox-ask-offer-what'; what.textContent = buttonWords(b);
            btn.setAttribute('aria-label', `${markHidden(b.label, { strict: true })}: ${what.textContent}`); btn.title = what.textContent;
            btn.addEventListener('click', async () => {
                err.textContent = ''; choices.forEach(c => { c.disabled = true; }); send.disabled = true;
                try {
                    const got = await claimButton(a, b); // the stored action, whatever the label says
                    if (isReply(got.action)) { asks = asks.filter(x => askKey(x) !== askKey(a)); fire(); refreshOperatorAsks(true); finish(); showToast(`Sent: ${markHidden(got.label, { strict: true })}`); return; }
                    finish(); // the dialog is modal: it goes before the page it opens
                    try {
                        if (got.action === 'open:new-agent') { if (!window.showLaunchModal) throw new Error('The New agent dialog is not available here.'); window.showLaunchModal(); }
                        else if (got.action === 'open:task') { if (!runners.task) throw new Error('Tasks cannot be opened here.'); runners.task(a, String(got.arg)); }
                        else if (got.action === 'open:artifact') { if (!runners.artifact) throw new Error('Files cannot be opened here.'); await runners.artifact(a, String(got.arg)); }
                        else if (got.action === 'wake') { await wakeMember(a, String(got.arg)); showToast(`Woke ${markHidden(got.arg, { strict: true })}.`); }
                        else throw new Error('This button does something this version does not know.');
                        await settleButton(a, b, 'done'); // closes the question
                    } catch (e) {
                        showToast(e.message || 'That did not work.', true);
                        await settleButton(a, b, 'failed').catch(() => {}); // the button is given back
                    }
                    refreshOperatorAsks(true);
                } catch (e) { err.textContent = e.message || 'Not done.'; choices.forEach(c => { c.disabled = false; }); send.disabled = false; }
            });
            choices.push(btn); item.append(btn, what); list.append(item);
        }
        offered.append(head, list);
    }
    dlg.append(title, sub, ...(whole.hidden ? [] : [whole]), ...(offered ? [offered] : []), label, pics, err, row);
    if (!fromAnotherComputer(a)) { // the picture is stored on the question's own team, as a goal's pictures are
        Promise.all([importOnce('./artifact_comment_images.js'), importOnce('./artifact_comments_api.js')]).then(([m, api]) => {
            if (!dlg.isConnected) return;
            tray = m.createImageTray({ upload: (blob, versionOf) => api.uploadCommentImage(null, undefined, blob, versionOf, a.board) });
            tray.attach(dlg, box); tray.listen(sync);
            pics.append(tray.picker(), tray.hint(), tray.node);
        }).catch(() => { /* a reply needs no picture: the dialog works without the button */ });
    }
    close.addEventListener('click', finish);
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    send.addEventListener('click', async () => {
        err.textContent = ''; send.disabled = true;
        const links = tray ? tray.hexes().map(h => `coral://artifacts/${h}`) : []; // each picture is named by its artifact link, which the board and the agents read
        try { await replyToAsk(a, [box.value.trim(), links.join('\n')].filter(Boolean).join('\n\n')); finish(); }
        catch (e) { err.textContent = e.message || 'Not sent.'; sync(); box.focus(); } // the text stays
    });
    document.body.append(dlg);
    dlg.showModal();
    box.focus();
    return dlg;
}
