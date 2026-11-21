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
}
