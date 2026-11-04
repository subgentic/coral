/* Send a file for review (#13152): the Operator's own way to put a stored file in Needs you's files to review, and to take it out again ("Remove from review"), from the Artifacts tab (a row's menu and the
 * selection bar) and the file viewer's menu. One dedicated route does both, for this computer and through Coral Hub alike (a Hub tags PUT may only add or remove "read", #13117):
 *   PUT    /api/board/<team>/artifacts/<id>/review   { question }   -> { id, tags, question }
 *   DELETE /api/board/<team>/artifacts/<id>/review                  -> { id, tags }
 * The server applies an upload's own rules (a file Needs you cannot show inline is refused, the question is cleaned and cut at 140 characters) and answers in words for a person. The question is optional
 * here: it is the Operator's own file. Lazy: the pages import it when the action is used. */
import { boardFetch } from './server_base.js';

const QUESTION_MAX = 140;

async function call(project, hex, method, body) {
    const r = await boardFetch(project, `/artifacts/${hex}/review`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Coral said ${r.status}`);
    return d;
}

/** Marks one file for review; resolves to { tags, question } as the server kept them, rejects with its words. */
export const sendForReview = (project, hex, question = '') => call(project, hex, 'PUT', { question: String(question || '').trim() });

/** Takes one file out of review; resolves to { tags }. */
export const removeFromReview = (project, hex) => call(project, hex, 'DELETE');

/** The same change on many files ([{ project, hex }]): each is its own call, the ones that failed are counted and the first reason is kept.
 *  Resolves to { ok: Map(hex -> tags), failed, why }. */
export async function changeMany(files, { question = '', remove = false } = {}) {
    const ok = new Map(); let failed = 0, why = '';
    for (const { project, hex } of files) {
        try { const d = remove ? await removeFromReview(project, hex) : await sendForReview(project, hex, question); ok.set(hex, Array.isArray(d.tags) ? d.tags : []); }
        catch (e) { failed++; why = why || e.message; }
    }
    return { ok, failed, why };
}

/** The Send for review dialog: the optional one-line question that sits above the file in Needs you ("Approve this phone layout?"). Resolves to the cleaned question ('' for none), or null when cancelled.
 *  { count, name } say what is being sent: one file by its name, or a number of files. */
export function askReviewQuestion({ count = 1, name = '' } = {}) {
    return new Promise(resolve => {
        const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
        const dlg = el('dialog', 'modal-content dlg-form send-review-dialog'); dlg.setAttribute('aria-labelledby', 'send-review-title');
        const title = el('h2', null, count === 1 && name ? `Send ${name} for review` : `Send ${count} files for review`); title.id = 'send-review-title';
        const sub = el('p', 'inbox-ask-sub', 'It goes to Needs you, to approve or ask for changes. Nobody is told until you decide.');
        const label = el('label', null, 'What should you decide? (optional)'); label.htmlFor = 'send-review-question';
        const box = el('input', 'field'); box.id = 'send-review-question'; box.type = 'text'; box.maxLength = QUESTION_MAX; box.placeholder = 'For example: Approve this layout?'; box.autocomplete = 'off';
        const hint = el('p', 'inbox-ask-sub', `One line, up to ${QUESTION_MAX} characters. It shows above the file in Needs you.`); hint.id = 'send-review-hint'; box.setAttribute('aria-describedby', 'send-review-hint');
        const row = el('div', 'inbox-ask-buttons');
        const cancel = el('button', 'btn', 'Cancel'), go = el('button', 'btn btn-primary send-review-go', 'Send for review'); cancel.type = go.type = 'button';
        row.append(cancel, go); dlg.append(title, sub, label, box, hint, row);
        let settled = false;
        const finish = value => { if (settled) return; settled = true; dlg.close(); dlg.remove(); resolve(value); };
        cancel.addEventListener('click', () => finish(null));
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
        go.addEventListener('click', () => finish(box.value.replace(/\s+/g, ' ').trim()));
        box.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
        document.body.append(dlg); dlg.showModal(); box.focus();
    });
}
