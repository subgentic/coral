/* Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question or for a permission carries the card's own choices (Yes, No, Red, Blue ...) as buttons, so a person answers
 * where they found it. The choices are read the way the chat reads them (the chat reply's prompt_options for that agent) and answered through the same route as the chat card (POST .../answer-prompt: the server re-reads the
 * terminal and sends the digit only if the option is still on screen under that label). A question the card cannot answer by one choice (a multi-select, a review step, a text answer, many choices) has no buttons: Open
 * stays for the full card. The labels are the CLI's own words, set as text.
 * A request that can only be rejected (cut, or holding a hidden character, or not text: the reply's only_reject, on prompt_options or on the pending tool, #11399) has no Allow on a row: only the No form of the card's
 * answers is a button, and the row says so; the server refuses an Allow for it too.
 * A row never grants more than this one time (#10400, Security): the choices that say "don't ask again", "always", "allow all", "this session", "switch to ..." are left to Open. The click re-reads the card and
 * sends only when it is still the ask the row was drawn for (the ask_id the chat reply carries, checked again by the server); otherwise the row is drawn again and says so. A viewer through the Hub has no buttons. */
import { serverFetch, sessionServer } from './server_base.js';
import { showToast } from './utils.js';
import { blockedReason, hubBlocked } from './hub_access.js';
import { resolveSessionIdentity } from './session_state.js';
import { waitIgnored, stalledOf } from './asked_before_restart.js';
import { build, keyRoute } from './routes.js';
import { boardTeamKey, keyLabel } from './server_base.js';
import { openAgent } from './agent_live.js';
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('inbox_answer.css'); // the step line's rules (#11981) are a sheet of their own: not in the start's stylesheet, and here before any step is drawn
const { canDismissWait, dismissButton, dismissWait, canRemoveWait, removeWait, REMOVE_WAIT_LINE } = await importOnce('./dismiss_wait.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried

const MAX_CHOICES = 4;
// Choices that last past this one answer, or change how the agent runs: never a button on a list row (each CLI's own words: Claude's "Yes, and don't ask again for ..." and "Yes, allow all edits during this session", Codex's "Yes, and don't ask again", Antigravity's "always allow").
const LASTING = /don.?t ask|install|always|never|allow all|all edits|session|conversation|switch to|persist|remember|from now on|auto mode|accept edits/i; // 'never' ("never show again", "never ask again") is a lasting setting too (#14728: Codex's rate-limit notice drew its "Keep current model (never show again)" as a button)
// A permission's choice is a button only when the WHOLE label (a trailing key hint like "(y)" and final punctuation dropped) is one of these one-time forms, and nothing else (Security Reviewer, #10462): Yes, Allow or Approve,
// optionally "once", "this once", "proceed", "continue", Antigravity's "run command"; No, Deny or Reject, optionally "cancel" or Codex's "and tell <CLI> what to do differently". Everything else, including every phrasing that
// lasts ("never ask again", "forever", "trust this workspace", "for the rest of this task") and every one that names a place, is left to Open.
const ONE_TIME = /^(?:(?:yes|allow|approve)(?:,? (?:once|this once|proceed|continue|run command))?|(?:no|deny|reject)(?:,? (?:cancel|and tell \w+ what to do differently))?)$/i;
const PERMISSION_WORDS = /^(yes|allow|approve)\b/i, SCOPE = /project|director|folder|repositor|\ball\b|\bfrom\b|\/|~/i;
const KEY_HINT = /\s*\((?:[a-z]|esc|enter|tab|shift\+tab|ctrl\+[a-z])\)$/i; // only a key in brackets is a hint: any other bracket ("(always)", "(all projects)") stays in the label, so the full match fails
// The answers of a request that can only be rejected: the No form of each CLI's words (the server accepts only these, 409 only_reject, for the rest).
const REJECT_FORM = /^(?:no|deny|reject|cancel)\b/i;
/** What a row says of a request Coral did not read in full (#15501): no answer is drawn, not even No; the terminal is the way on. A request read whole that only hides a character keeps its No (#15140). */
const UNREAD_ROW = 'Coral could not read this request in full. Answer it in the agent\u2019s terminal.';
const wholeLabel = label => label.trim().replace(KEY_HINT, '').replace(/[.!\s]+$/, '');
const plainlyOneTime = (label, permission) => permission ? ONE_TIME.test(wholeLabel(label)) : !LASTING.test(label) && !SCOPE.test(label); // a question card's own choices (Red, Blue) pass the words that mark a lasting or wide one
const read = new Map(); // server:session:waiting_since -> the choices, read once per ask
const stepClean = t => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim(); // the dialog's own words, as one clean line, uncut
const stepCut = t => (t.length > 80 ? `${t.slice(0, 79)}…` : t); // what is drawn: a cut field says so

// Claude's folder-trust menu is the ONE lasting grant a row may answer (#14110, Security): the server says so (trust_offer: the menu is exactly these two options, the person's own dashboard, a folder
// Coral may trust) and names the folder it read from the screen (trust_folder); this side checks the same two labels again, draws the folder as plain text and asks once more before Yes. Without the offer
// (a Hub viewer, a folder Coral may not trust) only No is a button and the rest is left to Open.
const TRUST_NO = 'no, exit', TRUST_YES = 'i trust this folder';
const trustMenu = po => {
    const o = po && po.options;
    if (!po || !po.unnumbered || !Array.isArray(o) || o.length !== 2) return null;
    const no = o[0], yes = o[1], said = x => String(x && x.label || '').trim().toLowerCase().replace(/^yes,\s*/, '');
    if (String(no.label || '').trim().toLowerCase() !== TRUST_NO || said(yes) !== TRUST_YES || !/^yes,/i.test(String(yes.label || '').trim())) return null;
    if (!Number.isInteger(Number(no.n)) || !Number.isInteger(Number(yes.n))) return null;
    const folder = typeof po.trust_folder === 'string' ? po.trust_folder : '';
    return { no, yes, why: stepClean(po.trust_why).slice(0, 160), folder: po.trust_offer === true && folder && stepClean(folder) === folder ? folder : '' }; // a folder with a hidden or control character is never offered
};

// Codex's "Approaching rate limits" notice (#14774, #14728 part (a); Security's conditions): the second lasting choice a row may answer, a named exception found by structure. The server says so (rate_limit_offer, with the
// model it read from the screen's own first option, to the person's own dashboard only); this side checks the same three labels again, draws the model as plain text and asks once more before choice 1 (it changes the
// model the agent runs with) and choice 3 (it stops the reminder for good). Without the offer (a Hub viewer, another menu) the generic rule stands: only Keep current model is a button.
const RL_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;
const rateLimitMenu = po => {
    const o = po && po.options, offer = po && po.rate_limit_offer;
    if (!po || po.unnumbered || po.multi || !offer || typeof offer.model !== 'string' || !RL_MODEL.test(offer.model) || !Array.isArray(o) || o.length !== 3) return null;
    const said = x => String(x && x.label || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!o.every((x, i) => Number(x.n) === i + 1)) return null;
    if (!said(o[0]).startsWith(`switch to ${offer.model.toLowerCase()}`) || said(o[1]) !== 'keep current model' || !said(o[2]).startsWith('keep current model (never show again)')) return null;
    return { model: offer.model, switchTo: o[0], keep: o[1], never: o[2] };
};

// Claude's "Claude wants to use your browser" menu (#14151): the server reads it by structure (browser_menu: the title, then exactly these three rows in this order, one marked, no numbers, no footer). The row takes ONE of
// them: "Not now" (Claude goes on without browser tools; nothing is installed, nothing is remembered). "Install extension" opens the person's Chrome and "Don't ask again" is lasting, so neither is a button: the row says so.
// This side checks the same three labels again, so a menu that is not exactly this one gets no button.
const BROWSER_LABELS = ['install extension', 'not now', "don't ask again"];
const browserMenu = po => {
    const o = po && po.options;
    if (!po || po.browser_menu !== true || !po.unnumbered || po.multi || !Array.isArray(o) || o.length !== 3) return null;
    if (!o.every((x, i) => String(x && x.label || '').trim().toLowerCase() === BROWSER_LABELS[i] && Number.isInteger(Number(x.n)))) return null;
    return { notNow: o[1] };
};
const BROWSER_NOTE = 'Not now: Claude goes on without browser tools; nothing is installed. To install the extension, or to stop being asked, open the agent.';

/** The card's one-time choices and the ask they belong to: { ask, picks, onlyReject } ({ ask: '', picks: [] } when the card cannot be answered by one choice). onlyReject: the request can only be rejected, and picks are then only the No form. */
async function readAsk(s) {
    const params = new URLSearchParams({ after: '0', limit: '1', session_id: s.session_id, agent_type: s.agent_type || '' });
    const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/chat?${params}`);
    if (!resp.ok) return { ask: '', picks: [], onlyReject: false };
    const reply = await resp.json().catch(() => null) || {};
    const po = reply.prompt_options;
    const onlyReject = !!(po && po.only_reject) || !!(reply.pending && reply.pending.input && reply.pending.input.only_reject === true);
    const unreadable = !!(po && po.unreadable) || !!(reply.pending && reply.pending.input && reply.pending.input.unreadable === true);
    const none = { ask: '', picks: [], onlyReject, unreadable };
    if (unreadable) return none; // not read in full: no answer of any kind on a row, and none of the request drawn as if it were the request (#15501)
    if (!po || po.multi) return none;
    if ((po.review || []).length) { // the last step of a multi-question dialog, "Ready to submit your answers?": the row can take it, since a Submit sends only what the person already chose (#11981)
        const submit = (po.options || []).find(o => (o.action || 'select') === 'select' && /^submit\b/i.test(String(o.label || '')) && Number.isInteger(Number(o.n)));
        const full = po.review.map(r => `${stepClean(r.question)}: ${stepClean(r.answer)}`).join(' · '), drawn = po.review.map(r => `${stepCut(stepClean(r.question))}: ${stepCut(stepClean(r.answer))}`).join(' · ');
        const lines = ['Submit these answers?', ...po.review.map(r => `${stepCut(stepClean(r.question))}: ${stepCut(stepClean(r.answer))}`)];
        return submit && !onlyReject ? { ask: String(po.ask_id || ''), picks: [submit], onlyReject, step: `Submit these answers? ${drawn}`, stepFull: `Submit these answers? ${full}`, lines } : none; // exactly what the screen shows now, every question with its answer: the click compares the UNCUT text, a field cut for drawing wears an ellipsis and the hover is the whole line (#11997, Security)
    }
    const browser = browserMenu(po);
    if (browser) return { ask: String(po.ask_id || ''), picks: [browser.notNow], onlyReject, browser: true, question: '' }; // only Not now is a button; Install and Don't ask again are left to Open, and the row says so
    const trust = trustMenu(po);
    if (trust) return trust.folder ? { ask: String(po.ask_id || ''), picks: [trust.no, trust.yes], onlyReject, trust: { folder: trust.folder, yes: trust.yes } } : { ask: String(po.ask_id || ''), picks: [trust.no], onlyReject, held: true, trustWhy: trust.why }; // No only, and the row says the rest is left to Open
    const rl = rateLimitMenu(po);
    if (rl) return { ask: String(po.ask_id || ''), picks: [rl.switchTo, rl.keep, rl.never], onlyReject, rateLimit: rl };
    if (po.unnumbered) return none; // an unnumbered menu that is neither the folder-trust nor the browser menu above: no button on a row (the arrows and Enter go into whatever is on that screen; #14151, UI Reviewer), the row says the rest is Open agent's
    const permission = (po.options || []).some(o => PERMISSION_WORDS.test(String(o.label || ''))); // a permission card: only a plain Yes or No is a button; a question's own choices (Red, Blue) are
    const picks = (po.options || []).filter(o => (o.action || 'select') === 'select' && o.label && Number.isInteger(Number(o.n)) && plainlyOneTime(String(o.label), permission) && (!onlyReject || REJECT_FORM.test(wholeLabel(String(o.label)))));
    // A question's choice the filter holds back (a lasting one, or one with a word like "Switch to", "from", "all") is left to Open as before, and the row says so: a partial list must not read as the whole list (the Mobile
    // Beta Tester's phone check, #11981).
    const selectable = (po.options || []).filter(o => (o.action || 'select') === 'select' && o.label && Number.isInteger(Number(o.n)));
    const held = !permission && !onlyReject && picks.length < selectable.length;
    const target = permission && typeof po.target === 'string' ? po.target : ''; // what the permission wants to run, as the server read it whole (#14173)
    // The row draws ALL of it, wrapped, and a Yes is a button only while the drawn block is not clipped (measured after layout and on resize, in fill): a request the row cannot show whole is refused or opened in the agent, never allowed blind (#14173, UI Reviewer and Security).
    const autoBlockAt = permission && typeof po.auto_block_at === 'string' ? po.auto_block_at : ''; // when Claude Code's own timer blocks the request by itself (#15140)
    const targetNote = permission && typeof po.target_note === 'string' ? stepClean(po.target_note).slice(0, 240) : '';
    return picks.length >= 1 && picks.length <= MAX_CHOICES ? { ask: String(po.ask_id || ''), picks, onlyReject, held, question: stepClean(po.question).slice(0, 120), target, targetNote, autoBlockAt } : { ...none, target, targetNote, autoBlockAt };
}

/** The agent's whole question for a row's Show all (#14637): what the chat card says, as one clean line, up to 4096 characters; '' when the read is refused or the agent asks nothing now. Read on the click only. */
export async function readWholeQuestion(s) {
    const params = new URLSearchParams({ after: '0', limit: '1', session_id: s.session_id, agent_type: s.agent_type || '' });
    const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/chat?${params}`);
    if (!resp.ok) return '';
    const reply = await resp.json().catch(() => null) || {};
    const q = stepClean(reply.prompt_options && reply.prompt_options.question);
    return q.length > 4096 ? `${q.slice(0, 4096)}\u2026` : q;
}

const askKey = s => `${sessionServer(s)}:${s.session_id}:${s.waiting_since || ''}`;

async function answer(s, o, ask, cell, step = '', trustFolder = '', rateLimitModel = '') { // step: the whole review text the row was drawn for ('' for a step with no review)
    cell._sig = null; lastRead.delete(`${sessionServer(s)}:${s.session_id}`); // the choices drawn again after this click come from a new reading, never the old one
    const buttons = [...cell.querySelectorAll('button')];
    const had = cell.contains(document.activeElement); // the keyboard is on a choice: it must still be on something when the cell is drawn again or says Answered (#10560)
    const keep = () => { if (had) (cell.querySelector(`.inbox-answer[data-n="${Number(o.n)}"]`) || cell.querySelector('.inbox-answer') || cell.closest('tr')?.querySelector('.dt-primary'))?.focus({ preventScroll: true }); };
    buttons.forEach(b => { b.disabled = true; });
    const began = { table: null }; document.dispatchEvent(new CustomEvent('coral:action-start', { detail: began })); // the table on screen when the Answer began: it is the one redrawn when this row leaves (#14408)
    try {
        if (await hubBlocked(s)) { buttons.forEach(b => { b.disabled = false; }); return; } // a viewer: the reason is said
        const now = await readAsk(s); // the card is read again at the click: a row can be stale
        if (!ask || now.ask !== ask || (step && now.stepFull !== step) || !now.picks.some(p => Number(p.n) === Number(o.n) && p.label === o.label) || (trustFolder && (!now.trust || now.trust.folder !== trustFolder)) || (rateLimitModel && (!now.rateLimit || now.rateLimit.model !== rateLimitModel))) { // a lasting rate-limit choice is sent only while the screen still offers that model // a Yes for a folder is sent only while the screen still names that folder // a Submit is sent only while the screen still shows the same review step with the same answers (#11981, Security)
            read.delete(askKey(s));
            fill(s, cell).then(keep);
            showToast('That question changed; look at it again.', true);
            return;
        }
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/answer-prompt`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: s.session_id, agent_type: s.agent_type || '', n: Number(o.n), label: o.label, text: '', ask_id: ask, ...(trustFolder ? { trust_folder: trustFolder } : {}), ...(rateLimitModel ? { rate_limit_model: rateLimitModel } : {}) }),
        });
        if (resp.status === 409) { // told apart by the server's code, never its words (#10516)
            const why = await resp.json().catch(() => ({}));
            if (why.code === 'trust_changed') { read.delete(askKey(s)); fill(s, cell).then(keep); showToast('The folder to trust changed or cannot be trusted from here. Open the agent to answer it.', true); return; } // the server refused the Yes: nothing was sent
            if (why.code === 'rate_limit_changed') { read.delete(askKey(s)); fill(s, cell).then(keep); showToast('The rate-limit notice changed or cannot be answered from here. Open the agent to answer it.', true); return; } // the server refused: nothing was sent
            if (why.code === 'ask_changed') { read.delete(askKey(s)); fill(s, cell).then(keep); showToast('That question changed; look at it again.', true); return; } // the server saw another ask than the one drawn
            if (why.code === 'answer_sent_prompt_open') { // the key went and the prompt had not cleared: the agent may still be waiting, so the row stays in Needs you (the feed removes it when the agent stops waiting) and says so
                read.delete(askKey(s));
                const next = await readAsk(s).catch(() => null); // a multi-question dialog moves to its next question or to "Ready to submit": that screen's choices are drawn, so the dialog is answered from here to its end (#11981)
                if (next && next.picks.length && next.ask && next.ask !== ask) { read.set(askKey(s), Promise.resolve({ ...next, later: true })); fill(s, cell).then(keep); return; }
                cell.replaceChildren(Object.assign(document.createElement('span'), { className: 'inbox-answered', textContent: `Sent: ${o.label}. Still waiting: check the agent.` }));
                return;
            }
            throw new Error(why.error || 'HTTP 409'); // nothing was sent (the selection did not move, Submit was not reached): the buttons stay, and the person is told
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        read.delete(askKey(s));
        cell.replaceChildren(Object.assign(document.createElement('span'), { className: 'inbox-answered', textContent: `Answered: ${o.label}` }));
        if (had) cell.closest('tr')?.querySelector('.dt-primary')?.focus({ preventScroll: true }); // the choices are gone: the keyboard stays in the row, on its Open
        showToast(`Answered: ${o.label} for ${resolveSessionIdentity(s)}`, false, 4000); // said once by the page's live region: nothing else says it
        document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { session_id: s.session_id, server: sessionServer(s), began, said: `Answered: ${o.label} for ${resolveSessionIdentity(s)}.` } })); // the list says it too when the row has gone (#10720)
    } catch {
        buttons.forEach(b => { b.disabled = false; });
        // the way to answer it is a button, not a place to go looking for (#10399): Open agent shows that agent's own card
        showToast('Could not send the answer from here. Open the agent to answer it there.', true, 10000, { action: { label: 'Open agent', onClick: () => { window.switchNavTab?.('agents'); Promise.resolve(window.selectLiveSession?.(s.name, s.agent_type, s.session_id, sessionServer(s))).then(() => window.showChatView?.()); } } });
    }
}

/** Yes for a folder asks once more on the row, with the folder as plain text (#14110): a lasting grant is never one click. Cancel draws the choices again; nothing is sent until the second press. */
function confirmTrust(s, o, ask, cell, trust) {
    const who = resolveSessionIdentity(s);
    cell.replaceChildren();
    const q = document.createElement('span'); q.className = 'inbox-trust-note inbox-trust-confirm'; q.setAttribute('role', 'group'); q.setAttribute('aria-label', `Trust this folder for ${who}?`);
    const path = document.createElement('code'); path.className = 'inbox-trust-path'; path.textContent = trust.folder;
    q.append('Trust ', path, ' for Claude, for every agent that starts there?');
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-small inbox-answer inbox-trust-go'; go.textContent = 'Trust this folder';
    go.dataset.session = s.session_id; go.dataset.n = String(Number(o.n)); go.setAttribute('aria-label', `Trust ${trust.folder} for Claude, for ${who}`);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-small inbox-trust-cancel'; cancel.textContent = 'Cancel';
    go.addEventListener('click', e => { e.stopPropagation(); answer(s, o, ask, cell, '', trust.folder); });
    cancel.addEventListener('click', e => { e.stopPropagation(); fill(s, cell).then(() => cell.querySelector('.inbox-answer')?.focus({ preventScroll: true })); });
    for (const b of [go, cancel]) b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
    cell.append(q, go, cancel);
    cancel.focus({ preventScroll: true }); // the safe choice has the keyboard; Enter does not trust by accident
}

// The second question before a rate-limit notice's lasting choices (#14774): choice 1 names the model it switches to, choice 3 says in plain words that it stops the reminder for good. Cancel has the keyboard.
function confirmRateLimit(s, o, ask, cell, rl) {
    const who = resolveSessionIdentity(s), never = o === rl.never;
    cell.replaceChildren();
    const q = document.createElement('span'); q.className = 'inbox-trust-note inbox-trust-confirm inbox-rate-limit-confirm'; q.setAttribute('role', 'group'); q.setAttribute('aria-label', never ? `Stop the reminder for ${who}?` : `Switch ${who} to ${rl.model}?`);
    if (never) q.append('This stops the reminder for good.');
    else { const m = document.createElement('code'); m.className = 'inbox-trust-path'; m.textContent = rl.model; q.append('Switch this agent to ', m, '? It changes the model the agent runs with.'); }
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-small inbox-answer inbox-trust-go'; go.textContent = never ? 'Never show again' : `Switch to ${rl.model}`;
    go.dataset.session = s.session_id; go.dataset.n = String(Number(o.n)); go.setAttribute('aria-label', never ? `Never show again: stops the rate-limit reminder for ${who}` : `Switch to ${rl.model}: ${who}`); // starts with the words on the button, so "click Never show again" finds it (WCAG 2.5.3, UI Accessibility on #14774)
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-small inbox-trust-cancel'; cancel.textContent = 'Cancel';
    go.addEventListener('click', e => { e.stopPropagation(); answer(s, o, ask, cell, '', '', rl.model); });
    cancel.addEventListener('click', e => { e.stopPropagation(); fill(s, cell).then(() => cell.querySelector('.inbox-answer')?.focus({ preventScroll: true })); });
    for (const b of [go, cancel]) b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
    cell.append(q, go, cancel);
    cancel.focus({ preventScroll: true }); // the safe choice has the keyboard; Enter does not confirm by accident
}

// A Yes on a permission row ignores clicks for ARM_MS after it is drawn or shown (#14302, Security's INFO on #14173): a row that arrives under a click, or a Yes that a measured block has just turned on, must not be approved by
// the click that was already on its way. The pointer leaving and entering the button again is a deliberate return: it arms the button at once.
const ARM_MS = 400;
const armedAsks = new Map(); // ask key -> { at: when its Yes is armed (0: armed by a deliberate return), seen: when a drawing last showed it }: kept per ask, so a Yes drawn again for the same ask (Needs you redraws often) stays armed (#14302)
const ASK_FORGET_MS = 30 * 60000;
function armYes(b, reshown = false) {
    const key = b._armKey, now = Date.now();
    for (const [k, e] of armedAsks) if (e.seen < now - ASK_FORGET_MS) armedAsks.delete(k); // an ask no drawing has shown for half an hour has left the list; armed time never decides this
    let e = key ? armedAsks.get(key) : null;
    if (!e) { e = { at: now + ARM_MS, seen: now }; if (key) armedAsks.set(key, e); }
    e.seen = now;
    if (reshown) e.at = now + ARM_MS; // the command gate turned a hidden Yes back on: armed again from this moment (Security)
    b._armEntry = e;
    if (Date.now() < e.at) b.classList.add('inbox-arming'); else b.classList.remove('inbox-arming');
    if (!b._armHooks) {
        b._armHooks = true;
        let left = false;
        b.addEventListener('pointerleave', () => { left = true; });
        b.addEventListener('pointerenter', () => { if (left) { b._armEntry.at = 0; b.classList.remove('inbox-arming'); } }); // the pointer left and came back: a deliberate return arms it at once, and the ask stays armed across redraws
    }
    setTimeout(() => { if (Date.now() >= b._armEntry.at) b.classList.remove('inbox-arming'); }, Math.max(0, e.at - Date.now()) + 30);
}
const stillArming = b => !!b._armEntry && Date.now() < b._armEntry.at;

const lastRead = new Map(); // `server:session` -> the last question read for that agent: a row drawn again for a new reading shows these choices until the new one is in, so its Yes is never gone in between (#15309)
/** Draws the choices into the cell once they are read (again after a question changed). */
function fill(s, cell, withDismiss = true) {
    const key = askKey(s), who = `${sessionServer(s)}:${s.session_id}`;
    const fresh = read.has(key);
    if (!fresh) read.set(key, readAsk(s).catch(() => ({ ask: '', picks: [], onlyReject: false, unreadable: false })).then(r => { lastRead.set(who, r); return r; }));
    const stale = fresh ? null : lastRead.get(who);
    const paint = r => { const sig = key + JSON.stringify(r); if (cell._sig === sig && cell._sigEl?.parentNode === cell) return; draw(r); cell._sig = sig; cell._sigEl = cell.firstChild; }; // the same reading for the same card leaves the choices as they are: a press on a Yes is not lost to a drawing under it (#15309)
    const draw = ({ ask, picks, onlyReject, unreadable, held, trustWhy, step, stepFull, question, later, lines, trust, rateLimit, browser, target, targetNote, autoBlockAt }) => {
        cell._cmdObserver?.disconnect(); cell._cmdObserver = null; // the earlier block's observer goes with the block (#14173)
        cell.replaceChildren();
        const said = norm => String(norm || '').replace(/[?\s]+$/, '');
        const words = step || (question && (later || !said(s.waiting_summary).includes(said(question))) ? question : ''); // the question is named when the row's own words do not carry it (a later step's never does)
        if (lines && lines.length) { const t = document.createElement('span'); t.className = 'inbox-answer-step'; if (stepFull && stepFull !== words) t.title = stepFull; lines.forEach(l => { const ln = document.createElement('span'); ln.className = 'inbox-answer-step-line'; ln.textContent = l.length > 240 ? `${l.slice(0, 239)}…` : l; t.append(ln, ' '); }); cell.append(t); } else if (words) { const t = document.createElement('span'); t.className = 'inbox-answer-step'; t.textContent = words.length > 240 ? `${words.slice(0, 239)}…` : words; if (stepFull && stepFull !== words) t.title = stepFull; else if (words.length > 240) t.title = words; cell.append(t); } // text only; a cut line (a field or the whole) says so and keeps the uncut text as its hover; the review's lines have a space between them: one run of words for a screen reader
        const yesButtons = [];
        let gate = null;
        if (target && target.trim()) { // the command on the row, all of it wrapped in a code block (3 lines, 4 on a phone), then Claude's own line under it, then what Yes allows (#14173)
            const block = document.createElement('pre'); block.className = 'inbox-cmd-block'; block.textContent = target.trim();
            block.setAttribute('aria-label', 'What it wants to run'); block.tabIndex = 0; // a keyboard can reach a block that scrolls
            cell.append(block);
            if (targetNote) { const nt = document.createElement('span'); nt.className = 'inbox-cmd-note'; nt.textContent = targetNote; cell.append(nt); }
            const yes = document.createElement('span'); yes.className = 'inbox-trust-note inbox-yes-note'; cell.append(yes);
            const more = document.createElement('button'); more.type = 'button'; more.className = 'btn btn-quiet btn-small inbox-cmd-more'; more.textContent = 'Show all'; more.hidden = true; more.setAttribute('aria-label', 'Show all of the command'); cell.insertBefore(more, yes);
            let open = false, reached = false;
            const laidOut = () => block.getClientRects().length > 0;
            const clipped = () => !(laidOut() && block.scrollHeight <= block.clientHeight + 1); // not laid out is not shown: fail closed
            const atEnd = () => laidOut() && block.scrollTop + block.clientHeight >= block.scrollHeight - 2;
            const allowed = () => !clipped() || (open && reached); // Yes only for a command shown whole, or one the person has scrolled to the end of
            const apply = () => {
                const c = clipped();
                if (open && atEnd()) reached = true;
                more.hidden = open || !c;
                const ok = allowed();
                yesButtons.forEach(b => { if (ok && b.hidden) { armYes(b, !!b._shownBefore); b._shownBefore = true; } b.hidden = !ok; }); // a Yes turned on for the first time in this drawing is armed as its ask is; one the gate turns off and on again is armed again from now
                yes.hidden = onlyReject || !picks.length;
                yes.textContent = ok ? 'Yes lets it run this once. No refuses it. Open the agent to read all of it or to allow more.' : open ? 'Read the whole command to allow it: scroll to the end of it.' : 'Read the whole command to allow it: press Show all. Or open the agent.';
            };
            more.addEventListener('click', e => { e.stopPropagation(); open = true; block.classList.add('is-open'); apply(); block.focus({ preventScroll: true }); });
            block.addEventListener('scroll', apply, { passive: true });
            if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(() => { if (!block.isConnected) { ro.disconnect(); return; } apply(); }); ro.observe(block); cell._cmdObserver = ro; } // one observer per drawn block: it goes when the cell is drawn again (below) or the block leaves the page
            gate = { clipped: () => !allowed(), apply };
        }
        if (browser) { const note = document.createElement('span'); note.className = 'inbox-trust-note inbox-browser-note'; note.textContent = BROWSER_NOTE; cell.append(note); } // what the one button does, and why the other two are not buttons (#14151)
        if (trust) { // the folder, plain text, and what Yes does, before any choice (#14110)
            const note = document.createElement('span'); note.className = 'inbox-trust-note';
            const path = document.createElement('code'); path.className = 'inbox-trust-path'; path.textContent = trust.folder;
            note.append('Folder: ', path, '. Yes adds this folder to Claude’s own trust list.');
            cell.append(note);
        }
        for (const o of picks) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-small inbox-answer'; b.textContent = o.label.length > 500 ? `${o.label.slice(0, 499).trimEnd()}\u2026` : o.label; b.title = o.label; // the whole label is the title and the name; only after 500 characters is the words cut (#14574)
            b.dataset.session = s.session_id; b.dataset.n = String(Number(o.n)); // what finds this choice again after a redraw keeps the keyboard on it (sidebar_groups.js)
            b.setAttribute('aria-label', `Answer ${o.label} for ${resolveSessionIdentity(s)}`);
            const isYes = gateOpt => !REJECT_FORM.test(wholeLabel(String(gateOpt.label)));
            if (typeof gate === 'object' && gate && isYes(o)) { yesButtons.push(b); b.hidden = true; } // hidden until measured: a Yes is never drawn before the block is known to be whole
            const permissionYes = s.waiting_kind === 'permission' && isYes(o); if (permissionYes) b._armKey = `${sessionServer(s)}:${s.session_id}:${s.waiting_since || ''}:${ask}:${o.label}`; if (permissionYes && !(gate && yesButtons.includes(b))) armYes(b); // a Yes of a permission is armed 400 ms after it is drawn (a gated one, when it is turned on)
            b.addEventListener('click', e => { e.stopPropagation(); if (permissionYes && stillArming(b)) return; if (gate && yesButtons.includes(b) && gate.clipped()) { gate.apply(); return; } if (trust && o === trust.yes) confirmTrust(s, o, ask, cell, trust); else if (rateLimit && (o === rateLimit.switchTo || o === rateLimit.never)) confirmRateLimit(s, o, ask, cell, rateLimit); else answer(s, o, ask, cell, stepFull || ''); });
            b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
            cell.append(b);
        }
        gate?.apply();
        if (held) { const more = document.createElement('span'); more.className = 'inbox-only-reject'; more.textContent = trustWhy ? `No Yes here: ${trustWhy} Open the agent to answer.` : 'More choices: open the agent.'; cell.append(more);
            if (typeof trustWhy === 'string') { const r = document.createElement('button'); r.type = 'button'; r.className = 'btn btn-small inbox-review-trust'; r.textContent = 'Review and trust'; r.setAttribute('aria-label', `Review and trust the folder of ${resolveSessionIdentity(s)}`); // the full card in a dialog over the Inbox, with Yes, I trust this folder (#15090; the row keeps #14110's rule)
                r.addEventListener('click', e => { e.stopPropagation(); importOnce('./inbox_agent_card.js').then(m => (m.canOpenCard(s) ? m.openAgentCard(s) : openAgent(s))); });
                r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }); cell.append(r); } } // some of the question's choices are left to Open: said, so these do not read as all of them
        if (onlyReject) { // said in words, set as text: the full request is under Open; with the time Claude Code's own timer blocks it, and one tap to the agent
            const note = document.createElement('span');
            note.className = unreadable ? 'inbox-only-reject inbox-unread' : 'inbox-only-reject';
            const t = autoBlockAt ? new Date(autoBlockAt) : null, at = t && !Number.isNaN(t.getTime()) ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
            note.textContent = unreadable ? UNREAD_ROW : `It can only be rejected here. Open the agent to read it${at ? `; Claude Code blocks it on its own at ${at}` : ''}.`;
            const o = document.createElement('button'); o.type = 'button'; o.className = unreadable ? 'btn btn-primary btn-small inbox-open-agent' : 'btn btn-small inbox-open-agent'; o.textContent = 'Open agent';
            o.setAttribute('aria-label', `Open ${resolveSessionIdentity(s)} to ${unreadable ? 'answer' : 'read the request'}`);
            o.addEventListener('click', e => { e.stopPropagation(); openAgent(s); });
            o.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
            cell.append(note, o);
        }
        if (!picks.length && !held && !onlyReject) { // nothing here can be answered (Claude's 'Is this a project you trust?' is such a prompt): the way on is the agent's own chat, one click away; nothing is typed for the person (#12346)
            const o = document.createElement('button'); o.type = 'button'; o.className = 'btn btn-small inbox-open-agent'; o.textContent = 'Open agent';
            o.setAttribute('aria-label', `Open ${resolveSessionIdentity(s)} to answer`);
            o.addEventListener('click', e => { e.stopPropagation(); openAgent(s); });
            o.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
            cell.append(o);
        }
        if (withDismiss && canDismissWait(s, s.waiting_kind)) { // a wait that is no longer true can be cleared here, on this computer only (#11352)
            const d = dismissButton('btn btn-small inbox-dismiss', s);
            d.setAttribute('aria-label', `Dismiss the wait of ${resolveSessionIdentity(s)}`);
            d.addEventListener('click', e => { e.stopPropagation(); dismissWait(s, d); });
            d.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
            cell.append(d);
        }
    };
    if (stale && stale.picks.length) Promise.resolve(stale).then(paint); // the earlier choices stand until the new reading is in
    return read.get(key).then(paint);
}

/** Whether a Needs you row offers its agent's answers at all: not a review or a run, not a viewer through the Hub, not a sign-in. */
const askable = s => !(s.review || s.autorun || !s.agent_type || !s.session_id || s.waiting_kind === 'login');
const answerable = s => askable(s) && !blockedReason(sessionServer(s), 'interact');
/** A question the person could answer but for the Hub's access to that computer (View only): the reason, so a row with no buttons says why (#15010). */
const viewOnlyWhy = s => (askable(s) ? blockedReason(sessionServer(s), 'interact') : '');

/** The actions of a phone Needs you row's ⋯ menu (#137104): the Dismiss of a wait that is no longer true, offered by the rule the desktop row's button follows. */
export function rowActions(s) {
    if (s.waiting_kind === 'stalled') { // nothing is waited on: no Dismiss; a phone row has no buttons, so its menu carries the two actions (#16921)
        const st = stalledOf(s); if (!st) return [];
        const team = boardTeamKey(sessionServer(s), s.board_project || '');
        return [{ label: 'Restart', title: 'Restart this agent with its settings; it gets its task again', run: () => restartStalled(s) },
            ...(s.board_project ? [{ label: 'Reassign', title: 'Open the task to give it to another agent', run: () => importOnce('./nav.js').then(m => m.go(keyRoute('team', team, 'tasks', st.id))) }] : [])];
    }
    if (s.waiting_for_input && waitIgnored(s)) return canRemoveWait(s) ? [{ label: 'Remove from Needs you', title: REMOVE_WAIT_LINE, help: REMOVE_WAIT_LINE, run: b => removeWait(s, b) }] : [];
    if (!canDismissWait(s, s.waiting_kind)) return []; // every waiting agent's row has one, a sign-in's too (#11946)
    return [{ label: 'Dismiss', title: 'Clear this if the agent is not waiting. Nothing is sent to the agent.', run: b => dismissWait(s, b) }];
}

/** Restart with the agent's own settings (one tap): selects the agent, then restarts. */
async function restartStalled(s) {
    try { const m = await importOnce('./agent_actions.js'); await m.restartSameDirect(s.name, s.agent_type, s.session_id); } catch { showToast(`Could not restart ${resolveSessionIdentity(s)}`, true); }
}

/** The actions of an agent that stopped with a task in progress (#16921): Restart (it gets its task brief again), the one primary action, and Reassign, which opens the task. Both are one tap; Restart keeps the agent's settings. */
function stalledCell(s) {
    const st = stalledOf(s), who = resolveSessionIdentity(s), cell = document.createElement('span'); cell.className = 'inbox-answers inbox-stalled';
    const restart = document.createElement('button'); restart.type = 'button'; restart.className = 'btn btn-primary btn-small inbox-stalled-restart'; restart.textContent = 'Restart';
    restart.setAttribute('aria-label', `Restart ${who}, stopped with task ${st.id} in progress`);
    const stop = e => e.stopPropagation();
    restart.addEventListener('click', async e => { e.stopPropagation(); restart.disabled = true; try { await restartStalled(s); } finally { restart.disabled = false; } });
    restart.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') stop(e); });
    cell.append(restart);
    const team = boardTeamKey(sessionServer(s), s.board_project || '');
    if (s.board_project) {
        const a = document.createElement('a'); a.className = 'btn btn-small inbox-stalled-reassign'; a.textContent = 'Reassign'; a.href = build(keyRoute('team', team, 'tasks', st.id));
        a.setAttribute('aria-label', `Reassign task ${st.id} from ${who} on ${keyLabel(team)}`); a.title = 'Open the task to give it to another agent';
        a.addEventListener('click', stop); a.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') stop(e); });
        cell.append(a);
    }
    return cell;
}

/** The Answer cell of a Needs you row: empty for a review or a run, for a viewer through the Hub, otherwise the one-time choices once they are read. `dismiss: false` leaves the Dismiss to the row's ⋯ menu (a phone's). */
export function answerCell(s, { dismiss = true } = {}) {
    if (s.waiting_kind === 'stalled' && stalledOf(s)) return stalledCell(s);
    if (s.waiting_for_input && waitIgnored(s) && !s.sleeping && !s.archived) {
        const cell = document.createElement('span'); cell.className = 'inbox-answers';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-small inbox-open-agent'; button.textContent = 'Open agent';
        button.setAttribute('aria-label', `Open ${resolveSessionIdentity(s)} to answer in its terminal`);
        button.addEventListener('click', e => { e.stopPropagation(); openAgent(s); });
        button.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
        cell.append(button);
        if (dismiss && canRemoveWait(s)) {
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-small btn-quiet inbox-remove-wait';
            remove.textContent = 'Remove from Needs you'; remove.title = REMOVE_WAIT_LINE;
            remove.addEventListener('click', event => { event.stopPropagation(); removeWait(s, remove); });
            const help = document.createElement('span'); help.className = 'inbox-remove-wait-help'; help.textContent = REMOVE_WAIT_LINE;
            cell.append(remove, help);
        }
        return cell;
    }
    if (!answerable(s)) { // a sign-in, or a viewer through the Hub: no answers, but the row can still be hidden (#11946); a viewer is told why there are no buttons (#15010)
        const why = viewOnlyWhy(s), canHide = dismiss && canDismissWait(s, s.waiting_kind);
        if (!why && !canHide) return '';
        const only = document.createElement('span'); only.className = 'inbox-answers';
        if (why) { const note = document.createElement('span'); note.className = 'inbox-trust-note inbox-answer-why'; note.textContent = 'View only through Coral Hub'; note.title = why; only.append(note); }
        if (canHide) {
            const d = dismissButton('btn btn-small inbox-dismiss', s);
            d.setAttribute('aria-label', `Dismiss the wait of ${resolveSessionIdentity(s)}`);
            d.addEventListener('click', e => { e.stopPropagation(); dismissWait(s, d); });
            d.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
            only.append(d);
        }
        return only;
    }
    const cell = document.createElement('span');
    cell.className = 'inbox-answers';
    fill(s, cell, dismiss);
    return cell;
}
