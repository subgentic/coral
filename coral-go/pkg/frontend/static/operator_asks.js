/* Questions to the Operator in their Needs you (#11417). An agent asks the Operator with `coral-board post --ask "@Operator ..."` or `coral-board wait --operator "..."`; neither was in the Inbox, which is
 * built from the live list, so the person did not see what they were asked. GET /api/operator-asks lists both for every board (the whole question as text); a row of Needs you says who asks and the question
 * on one line, and opens whole in a dialog with a Reply box. The reply is the board post the dashboard already makes (POST /api/board/{board}/messages as the Operator, with the asker's @name, and reply_to
 * for an ask): it answers the ask, ends a wait, and tells the asker by the post itself. The text is the agent's, so it is written out through markHidden (strict) before it is drawn, then cut. */
import { markHidden } from './visible_marks.js';
import { isHiddenAsk } from './ask_filter.js';
import { importOnce } from './import_once.js';
import { OPERATOR_ID } from './utils.js';
import { state } from './state.js';
import { showToast } from './notifications.js';
import { isCloud, isLocalServer, serverFetch, LOCAL_SERVER, normServer, sessionServer } from './server_base.js';
import { inboxSources } from './inbox_servers.js';

const FRESH_MS = 15000, LINE_MAX = 140;
let asks = [], pending = null, lastRead = 0;
const listeners = new Set();
/** The open questions, oldest first (without one that only links a file for review). */
export const operatorAsks = () => asks.filter(a => !isHiddenAsk(a));
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
/** A row only previews: the text is cut to this many characters BEFORE the Markdown marks are dropped (that pass is quadratic on adversarial text: 20 KB took 250 ms a row, #12152), and the marks are written after. */
const PREVIEW_IN = 500;
const previewText = a => markHidden(String((a && a.text) == null ? '' : a.text).slice(0, PREVIEW_IN), { strict: true });
/** A question as one line of a row: hidden characters written out, Markdown marks dropped, white space collapsed, cut after marking so a mark is never split. */
export function askLine(a) {
    const one = plainMarkdown(previewText(a)).replace(/\s+/g, ' ').trim();
    return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1).trimEnd()}…` : one;
}
/** The whole question, hidden characters written out, line breaks kept. */
export const askWhole = a => markHidden(a && a.text, { strict: true });
/** The whole question as plain text (a row's second line): the same words, line breaks kept, without the Markdown marks. */
export const askPlain = a => plainMarkdown(previewText(a));
/** A stable id of one question among the rows. */
export const askKey = a => `operator-ask:${a.server && !isLocalServer(a.server) ? `${a.server}/` : ''}${a.board}:${a.kind}:${a.id}`; // two computers can each have a team of one name and a question of one number

/** Read the list (at most once in 15 s unless forced; one read at a time). Safe to call after every live update. */
export function refreshOperatorAsks(force = false) {
    if (pending) return pending;
    if (!force && Date.now() - lastRead < FRESH_MS) return null;
    lastRead = Date.now();
    // Every computer the page reads (this one, and each registered computer that is online through the Hub; through the Hub itself only those): a bare /api path through the Hub is the Hub's own, which has no questions (#12612, coral-hub #156454).
    // A row from another computer carries that computer's id, so the dialog and the row know it is not this one's; a computer that cannot be read keeps the rows it had.
    const sources = inboxSources(), asked = sources.length ? sources : [LOCAL_SERVER];
    pending = Promise.all(asked.map(server => serverFetch(server === LOCAL_SERVER ? undefined : server, '/api/operator-asks').then(r => (r.ok ? r.json() : null)).then(rows => (Array.isArray(rows) ? rows.map(a => (server === LOCAL_SERVER || !a || typeof a !== 'object' ? a : { ...a, server })) : null), () => null))).then(results => {
        const next = [];
        results.forEach((rows, k) => {
            const server = asked[k];
            if (rows === null) { next.push(...asks.filter(a => (server === LOCAL_SERVER ? !a.server : a.server === server))); return; } // refused or failed: what is drawn stays (a viewer who may not read it has none)
            next.push(...rows.filter(a => a && typeof a.board === 'string' && typeof a.asker === 'string' && Number.isFinite(Number(a.id))));
        });
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
    const resp = await serverFetch(a.server, `/api/board/${encodeURIComponent(a.board)}/messages`, {
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
// our own words in its accessible name and tooltip, so a label like "Cancel" cannot hide that it wakes an agent. A click claims the button on the server, which answers with the STORED action: the page runs only that, never anything it
// holds itself. A reply is run by the server (posted as the Operator, said to be a click, the question closed); open and wake run here through the routes the dashboard already uses, then the page settles.

/** Whether the question came from another computer, or the page is the Hub's (#11757, Security's INFO on #11643): the claim and settle routes are not served through Coral Hub, so a button there would only fail with an error. */
export const fromAnotherComputer = a => isCloud() || (!!a && typeof a.server === 'string' && a.server !== '' && !isLocalServer(a.server));

/** The buttons of a question that can still be used: only a question (not a wait) has them, and a used one is gone. */
export const buttonsOf = a => (a && a.kind === 'ask' && Array.isArray(a.buttons) ? a.buttons.filter(b => b && b.state === 'pending' && Number.isFinite(Number(b.id)) && typeof b.label === 'string' && typeof b.action === 'string') : []);

/** Only an explicit, complete Yes/No reply declaration gets Approve/Deny (#13735).
 * No inspection of question prose, synonyms, punctuation, hidden text or extra actions. */
export const yesNoButtons = a => {
    const buttons = buttonsOf(a);
    return buttons.length === 2 && buttons.every(b => /^reply$/.test(b.action) && !b.arg) && buttons.some(b => b.label === 'Yes') && buttons.some(b => b.label === 'No');
};

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
    const resp = await serverFetch(a.server, buttonUrl(a, b, verb), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
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
    const server = normServer(a.server);
    const r = await serverFetch(server, `/api/board/${encodeURIComponent(a.board)}/subscribers`);
    if (!r.ok) throw new Error(`Could not read this team's members (HTTP ${r.status}).`);
    const subs = await r.json().catch(() => []);
    const sub = (Array.isArray(subs) ? subs : []).find(x => x && x.subscriber_id === name);
    if (!sub || !sub.session_name) throw new Error(`${who} is not a member of this team that Coral can wake.`);
    const live = (state.liveSessions || []).find(s => sessionServer(s) === server && `${s.agent_type}-${s.session_id}` === sub.session_name);
    if (!live) throw new Error(`${who} is not running on this computer.`);
    if (!live.sleeping) throw new Error(`${who} is not asleep.`);
    const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(live.session_id)}/wake`, { method: 'POST' });
    if (!resp.ok) { // the server says why in a sentence (a CLI not installed, a path it cannot run: cli_not_found, cli_path_unusable, cli_untrusted_mount) and what to set: show it, not the status code (#12049)
        const why = await resp.json().then(b => (b && typeof b.error === 'string' ? b.error.trim() : ''), () => '');
        throw new Error(why ? `Could not wake ${who}: ${markHidden(why, { strict: true })}` : `Could not wake ${who} (HTTP ${resp.status}).`);
    }
}

/** The dialog names the asker and team; the complete question is shown once in its body (#12722). */
export function askParts(a) {
    return { title: `${markHidden(a.asker || 'Agent', { strict: true })} · ${markHidden(a.board_label || a.board || 'Team', { strict: true })}`,
        body: listsOf(askWhole(a).replace(/^\s*@Operator\b[:,]?\s*/i, '').trim()) };
}

/** A question written on one line with its steps inline ("... console: 1. Open it. 2. Generate a token. 3. Save it.") is set out as a list: a blank line before the first step and each step on its own line. Only when the
 * numbers run 1, 2, ... in order (so "version 2.5" or a date is left alone) and the text has no line breaks of its own to go by. */
export function listsOf(text) {
    if (/\n/.test(text)) return text;
    const marks = [];
    for (let n = 1, from = 0; n < 50; n++) {
        const m = new RegExp(`(?:^|[\\s])${n}[.)]\\s+(?=\\S)`).exec(text.slice(from));
        if (!m) break;
        marks.push(from + m.index + (m[0].length - m[0].trimStart().length)); // where the number starts
        from = from + m.index + m[0].length;
    }
    if (marks.length < 2) return text;
    const parts = [text.slice(0, marks[0]).trimEnd(), ...marks.map((at, i) => text.slice(at, marks[i + 1] ?? text.length).trim())];
    return parts[0] ? `${parts[0]}\n\n${parts.slice(1).join('\n')}` : parts.slice(1).join('\n');
}

/** The goal and the task a question was asked about (#12194, #12164): [{ kind, id, title }], the goal first; empty when the asker named neither. */
export function askSubjects(a) {
    const out = [];
    if (a && Number(a.goal_id) > 0) out.push({ kind: 'goal', id: Number(a.goal_id), title: markHidden(a.goal_title || '', { strict: true }) });
    if (a && Number(a.task_id) > 0) out.push({ kind: 'task', id: Number(a.task_id), title: markHidden(a.task_title || '', { strict: true }) });
    return out;
}
/** The question whole, with a Reply box: a modal dialog (focus kept inside it, Escape closes it). */
/** Load the reply/action UI only when the person opens a question. Resolves to its dialog. */
export async function openAskDialog(a, onDone, runners = {}) {
    try { return (await importOnce('./operator_ask_dialog.js')).openAskDialog(a, onDone, runners); }
    catch (e) { showToast('The reply could not be opened. Try again.', true); throw e; }
}
/** Remove one answered/dismissed ask from the shared list, then notify its readers. */
export function forgetAsk(a) { asks = asks.filter(x => askKey(x) !== askKey(a)); fire(); }
