// An automation a team's Orchestrator proposed waits for the Operator in Needs you (#21505), loaded only when one is shown. The question has two buttons, Approve and Deny, that Coral itself put there; the click runs on
// the server against the hash the question was filed with. The card shows every step whole: all of it is set with textContent, nothing the Orchestrator wrote is ever parsed as markup.
import { buttonsOf, buttonsOffered, claimButton, forgetAsk, refreshOperatorAsks } from './operator_asks.js';
import { loadStyles } from './lazy_styles.js';
import { showToast } from './utils.js';
import { markHidden } from './visible_marks.js';
import { modelName, typeName } from './model_labels.js';

/** The Approve and Deny buttons of an automation question, or null when it has any other buttons. */
export function automationButtons(a) {
    const buttons = buttonsOf(a);
    const yes = buttons.find(b => b.action === 'approve-automation' && (b.label === 'Approve' || b.label === 'Approve again'));
    const no = buttons.find(b => b.action === 'deny-automation' && b.label === 'Deny');
    return buttons.length === 2 && yes && no ? { approve: yes, deny: no } : null;
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const short = h => String(h || '').slice(0, 8);

/** "name:hash" of a button argument. */
function splitArg(arg) { const at = String(arg || '').lastIndexOf(':'); return at > 0 ? { name: arg.slice(0, at), hash: arg.slice(at + 1) } : { name: '', hash: '' }; }

function fact(dl, label, value, extra) {
    dl.append(el('dt', '', label)); const dd = el('dd', '', value); if (extra) dd.append(extra); dl.append(dd);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The card's words for when the schedule runs: "Every weekday at 07:30 (Chicago time)" for the plain shapes, the cron text and its zone for any other, "Only when someone runs it" for none. */
function schedule(v) {
    if (!v.cron) return 'Only when someone runs it (no schedule)';
    const tz = v.timezone || 'UTC', zone = tz === 'UTC' ? 'UTC' : `${tz.split('/').pop().replace(/_/g, ' ')} time`;
    const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|0,6|[0-7])$/.exec(v.cron);
    if (!m || +m[1] > 59 || +m[2] > 23) return `${v.cron} (${tz})`;
    const at = `${String(m[2]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')}`;
    const who = m[3] === '*' ? 'Every day' : m[3] === '1-5' ? 'Every weekday' : m[3] === '0,6' ? 'Every weekend day' : `Every ${DAYS[+m[3] % 7]}`;
    return `${who} at ${at} (${zone})`;
}

const ALIAS = /^(opus|sonnet|haiku|fable)$/i;
/** The agent type and model as the rest of the app names them: "Claude", "Sonnet 5.5" (an alias with no version reads "Sonnet"). */
const agentWords = t => typeName(t || 'claude');
const modelWords = (t, m) => { const n = modelName(t || 'claude', m); return ALIAS.test(n) ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : n; };
const FIELDS = { model: 'Model', agent_type: 'Agent', timeout_s: 'Time limit', command: 'Command', prompt: 'Prompt', name: 'Name', type: 'Kind', continue_on_failure: 'If it fails' };
/** One line of "what changed" in words: the schedule as the Runs row says it, step fields by their names, a model as its name. */
function changeWords(line) {
    const sign = line[0], rest = line.slice(2);
    let m = /^Schedule: (.*)$/.exec(rest);
    if (m) { const i = m[1].lastIndexOf(' '); return `${sign} Schedule: ${schedule({ cron: m[1].slice(0, i), timezone: m[1].slice(i + 1) }).replace(/^Only when.*/, 'none (only when someone runs it)')}`; }
    m = /^(Step \d+) \u00b7 (\w+): (.*)$/.exec(rest);
    if (m) {
        const [, where, key, val] = m;
        const shown = key === 'model' ? (val ? modelWords('claude', val) : 'default') : key === 'agent_type' ? agentWords(val) : key === 'timeout_s' ? (val ? `${val} seconds` : 'none') : key === 'continue_on_failure' ? (val === 'true' ? 'keeps going' : 'stops the run') : val;
        return `${sign} ${where} \u00b7 ${FIELDS[key] || key}: ${shown}`;
    }
    return line;
}

function stepBlock(v, s) {
    const box = el('div', 'autoc-step'); const head = el('div', 'autoc-step-head');
    head.append(el('strong', '', `Step ${s.index}`), el('span', 'chip chip-tag', s.type === 'agent' ? 'Agent' : 'Shell'), el('span', 'autoc-step-note', s.continue_on_failure ? 'keeps going if it fails' : 'stops the run if it fails'));
    const body = el('div', 'autoc-step-body'); const dl = el('dl', 'autoc-dl');
    if (s.type === 'agent') {
        fact(dl, 'Agent type', agentWords(s.agent_type)); if (s.model) fact(dl, 'Model', modelWords(s.agent_type, s.model));
        fact(dl, 'Mode', 'Default: the permissions of an agent the Orchestrator launches; it cannot be given more');
    }
    fact(dl, 'Working folder', v.repo_path); if (s.timeout_s) fact(dl, 'Time limit', `${s.timeout_s} seconds`);
    body.append(dl);
    const text = s.type === 'agent' ? s.prompt : s.command;
    const pre = el('pre', 'autoc-text', text); pre.tabIndex = 0; pre.setAttribute('aria-label', `${s.type === 'agent' ? 'The prompt' : 'The command'} of step ${s.index}, in full`);
    body.append(pre);
    if (text.length > 400 || text.split('\n').length > 8) body.append(el('div', 'autoc-hint', 'Scrolls inside the box. Nothing is cut off.'));
    if (s.file) { const n = el('div', 'autoc-note autoc-note-ok'); const w = el('div', 'autoc-note-text'); w.append(el('code', '', s.file), el('span', '', 'is part of this approval; if it changes, the run stops and you are asked again. It covers this file only, not what the file runs.')); n.append(el('b', '', '✓ '), w); body.append(n); }
    else if (s.editable_files) { const n = el('div', 'autoc-note autoc-note-warn'); n.append(el('b', '', '! '), document.createTextNode('Runs files your team can change after you approve.')); body.append(n); }
    box.append(head, body); return box;
}

function changedBlock(v) {
    const box = el('div', 'autoc-changed'); box.append(el('h4', '', 'What changed since you approved'));
    const diff = el('div', 'autoc-diff'); diff.setAttribute('role', 'list');
    for (const line of v.changes || []) diff.append(Object.assign(el('div', line.startsWith('+') ? 'a' : 'd', changeWords(line)), { role: 'listitem' }));
    if (diff.childElementCount) box.append(diff);
    const p = el('p', 'autoc-hint'); p.append(document.createTextNode('It was approved as '), el('code', '', short(v.approved_hash)), document.createTextNode('. This version is '), el('code', '', short(v.hash)), document.createTextNode('. It has been off since the change, and nothing ran from this version.')); box.append(p);
    return box;
}

/** The whole card for an automation the server describes: facts, then every step. */
export function automationCard(v) {
    const card = el('div', 'autoc'); card.setAttribute('data-automation-card', '');
    if (v.state === 'changed') card.append(changedBlock(v));
    const dl = el('dl', 'autoc-dl autoc-facts');
    fact(dl, 'Workflow', v.name); fact(dl, 'Team', v.team); fact(dl, 'Repo folder', v.repo_path); fact(dl, 'Runs', schedule(v));
    fact(dl, 'Proposed by', `Orchestrator of ${v.team}`);
    const hash = el('code', 'autoc-hash', v.hash.slice(0, 16)); hash.title = v.hash; fact(dl, 'Hash', '', hash); dl.lastChild.append(el('span', 'autoc-hint-inline', ' covers every step below, the schedule and the folder'));
    if (v.description) fact(dl, 'About', v.description);
    card.append(dl, el('h4', 'autoc-steps-title', `${v.steps.length} step${v.steps.length === 1 ? '' : 's'}, in order`));
    for (const s of v.steps) card.append(stepBlock(v, s));
    card.append(el('p', 'autoc-rule', 'Nothing runs until you approve. Approving enables exactly this version; any later edit turns it off and asks you again.'));
    return card;
}

/** Puts Approve and Deny in the row's action box, and the whole card in its text cell. */
export function addAutomationButtons(a, box) {
    const auto = buttonsOffered(a).length ? automationButtons(a) : null;
    if (!auto) return;
    const who = markHidden(a.asker, { strict: true });
    const { name, hash } = splitArg(auto.approve.arg);
    const again = auto.approve.label === 'Approve again';
    const all = () => box.querySelectorAll('[data-automation-action]');
    const made = [[auto.approve, true], [auto.deny, false]].map(([b, yes]) => {
        const btn = el('button', `btn btn-small ${yes ? 'inbox-main-action inbox-approve-action' : 'inbox-deny-action'}`, yes ? (again ? 'Approve again' : 'Approve') : 'Deny'); btn.type = 'button';
        btn.setAttribute('data-automation-action', yes ? 'approve' : 'deny');
        btn.setAttribute('aria-label', `${yes ? 'Approve' : 'Deny'} the automation ${name} of ${who}: ${yes ? 'it is turned on exactly as shown' : again ? 'it stays off' : 'the proposal is removed'}`);
        btn.addEventListener('click', async e => {
            e.stopPropagation(); for (const x of all()) x.disabled = true;
            try {
                const got = await claimButton(a, b);
                if (!got.ran) { for (const x of all()) x.disabled = false; return; }
                forgetAsk(a); refreshOperatorAsks(true); showToast(got.result === 'approved' ? 'Automation approved: it is on, exactly as shown.' : again ? 'Denied: the automation stays off.' : 'Denied: the proposal is removed.');
            } catch (err) {
                for (const x of all()) x.disabled = false;
                if (err && (err.code === 'automation_changed' || err.code === 'automation_gone')) { forgetAsk(a); refreshOperatorAsks(true); }
                showToast((err && err.message) || 'Not done.', true);
            }
        });
        return btn;
    });
    box.prepend(...made);
    const hint = el('span', 'autoc-actions-hint', again ? 'Deny keeps it off. You can approve it later from Automations.' : 'Deny removes the proposal. Only you can approve it, on this computer: a Hub link cannot.'); hint.setAttribute('data-automation-hint', '');
    box.append(hint);
    drawCard(a, box, name, hash, again).catch(() => {});
}

const seen = new Map(); // board/name/hash -> the automation as the server described it: a redraw of the row paints the card at once, with no "Loading" in between

async function drawCard(a, box, name, hash, again) {
    await loadStyles('automation_card.css');
    // the row is drawn after this module is asked for: find its cell once it is in the page
    for (let i = 0; i < 20 && !box.closest('tr'); i++) await new Promise(r => setTimeout(r, 25));
    const row = box.closest('tr'); if (!row) return;
    const cell = row.querySelector('.inbox-agent-first'), msg = cell && cell.querySelector('.inbox-ask-name'); if (!msg) return;
    // the question's own words are replaced by the card: its title, then the details in the message box
    msg.classList.remove('inbox-preview'); msg.classList.add('autoc-msg'); cell.querySelector('.inbox-preview-toggle')?.remove();
    msg.replaceChildren(el('strong', 'autoc-title', `${again ? 'Changed since you approved' : 'Approve an automation'}: ${name}`));
    const kind = cell.querySelector('.inbox-kind-ask'); if (kind) kind.textContent = 'Automation approval';
    const chip = el('span', again ? 'chip autoc-chip-off' : 'chip autoc-chip-warn', again ? 'Off until you approve again' : 'Starts off'); chip.setAttribute('data-automation-state', '');
    cell.querySelector('.inbox-meta')?.append(chip);
    const key = `${a.board}/${name}/${hash}`;
    if (seen.has(key)) { msg.append(automationCard(seen.get(key))); return; }
    const holder = el('div', 'autoc'); holder.setAttribute('data-automation-card', ''); holder.textContent = 'Loading the automation\u2026'; msg.append(holder);
    try {
        const r = await fetch(`/api/board/${encodeURIComponent(a.board)}/automations/${encodeURIComponent(name)}`, { cache: 'no-store' });
        const v = r.ok ? (await r.json()).automation : null;
        if (!v) { holder.textContent = 'The automation could not be loaded. Approving still works from the words of the question.'; return; }
        if (v.hash !== hash) { holder.textContent = 'This automation changed after the question was filed; look at the new question.'; return; }
        seen.set(key, v); holder.replaceWith(automationCard(v));
    } catch { holder.textContent = 'The automation could not be loaded. Try again.'; }
}
