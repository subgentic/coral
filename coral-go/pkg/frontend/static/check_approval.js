// A custom check's approval question in Needs you (#20139), loaded only when one is shown. Coral files the question with exactly two buttons, Approve and Deny; the click runs on the server, against the record the
// question was filed with, and the page only shows the answer.
import { buttonsOf, buttonsOffered, claimButton, forgetAsk, refreshOperatorAsks } from './operator_asks.js';
import { showToast } from './utils.js';
import { markHidden } from './visible_marks.js';

/** The Approve and Deny buttons of a check question, or null when it has any other buttons. */
export function checkButtons(a) {
    const buttons = buttonsOf(a);
    const one = (action, word) => buttons.find(b => b.action === action && b.label === word);
    return buttons.length === 2 && one('approve-check', 'Approve') && one('deny-check', 'Deny') ? { approve: one('approve-check', 'Approve'), deny: one('deny-check', 'Deny') } : null;
}

/** Puts Approve and Deny in the row's action box, before its other buttons. */
export function addCheckButtons(a, box) {
    if (buttonsOf(a).some(b => b.action === 'approve-automation')) return import('./automation_approval.js').then(m => m.addAutomationButtons(a, box)); // an automation an Orchestrator proposed (#21505)
    const check = buttonsOffered(a).length ? checkButtons(a) : null;
    if (!check) return;
    const who = markHidden(a.asker, { strict: true });
    const all = () => box.querySelectorAll('[data-check-action]');
    const made = [[check.approve, true], [check.deny, false]].map(([b, yes]) => {
        const btn = document.createElement('button'); btn.type = 'button';
        btn.className = `btn btn-small ${yes ? 'inbox-main-action inbox-approve-action' : 'inbox-deny-action'}`; btn.textContent = yes ? 'Approve' : 'Deny';
        btn.setAttribute('data-check-action', yes ? 'approve' : 'deny');
        btn.setAttribute('aria-label', `${yes ? 'Approve' : 'Deny'} the custom check of ${who}: ${yes ? 'it will run as written' : 'it is removed'}`);
        btn.addEventListener('click', async e => {
            e.stopPropagation(); for (const x of all()) x.disabled = true;
            try {
                const got = await claimButton(a, b);
                if (!got.ran) { for (const x of all()) x.disabled = false; return; }
                forgetAsk(a); refreshOperatorAsks(true); showToast(got.result === 'approved' ? 'Check approved: it runs from now on.' : 'Check denied and removed.');
            } catch (err) {
                for (const x of all()) x.disabled = false;
                if (err && err.code === 'check_changed') { forgetAsk(a); refreshOperatorAsks(true); }
                showToast((err && err.message) || 'Not done.', true);
            }
        });
        return btn;
    });
    box.prepend(...made);
    box.append(...scriptToggle(a, check.approve.arg));
}

/** A "Script" button and the script text beside the hash (#20220): fetched when opened, shown escaped by the server, in a box that scrolls. It shows nothing if the check is no longer the one asked about. */
function scriptToggle(a, arg) {
    const at = String(arg || '').lastIndexOf(':'), name = at > 0 ? arg.slice(0, at) : '', hash = at > 0 ? arg.slice(at + 1) : '';
    if (!name || !hash) return [];
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-quiet btn-small'; btn.textContent = 'Script'; btn.setAttribute('data-check-script', '');
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', 'Show the text of the script this check runs');
    const pre = document.createElement('pre'); pre.hidden = true; pre.tabIndex = 0; pre.setAttribute('data-check-script-text', ''); pre.setAttribute('aria-label', 'The script text, special characters written as escapes');
    Object.assign(pre.style, { flexBasis: '100%', width: '100%', maxHeight: '12em', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0', fontSize: '0.85em', textAlign: 'left' });
    let loaded = false;
    btn.addEventListener('click', async e => {
        e.stopPropagation();
        pre.hidden = !pre.hidden; btn.setAttribute('aria-expanded', String(!pre.hidden));
        if (pre.hidden || loaded) return;
        loaded = true; pre.textContent = 'Loading the script…';
        try {
            const r = await fetch(`/api/board/${encodeURIComponent(a.board)}/health/checks`, { cache: 'no-store' });
            const c = r.ok ? ((await r.json()).checks || []).find(x => x.name === name) : null;
            pre.textContent = c && c.record_hash === hash ? (c.script_text || 'The script text is not available.') : 'This check changed after the question was filed; look at the new question.';
        } catch { loaded = false; pre.textContent = 'The script could not be loaded. Try again.'; }
    });
    return [btn, pre];
}
