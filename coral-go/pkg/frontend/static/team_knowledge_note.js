/* The Knowledge tab's "Add note" form (#17485): a title and some text that become a note of the team's knowledge (POST /api/teams/detail/{team}/knowledge). It opens in the right pane, as an entry's Edit does:
 * Cancel at the left of the pane's bar and Save at the right, a status line beside them, and Escape or Cancel ask once, in the bar, when something was typed. Lazy: the Knowledge tab imports it when the button is pressed,
 * so the page's first paint carries none of it. Built with the DOM and textContent. */
import { teamFetch } from './server_base.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

/** Opens the form. `pane` is detail_pane.js (openDetailPane, closeDetailPane); `onSaved(name)` runs after a note was written (the page reads the table again and opens it). */
export function openNoteForm({ team, pane, opener, onSaved }) {
    let title = null, text = null;
    const status = el('span', 'detail-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const say = (t) => { status.textContent = ''; status.textContent = t; };
    const foot = () => document.querySelector('#detail-pane .detail-foot');
    const save = btn('btn btn-primary', 'Save note', null), cancel = btn('btn', 'Cancel', null);
    const dirty = () => !!(title && text && (title.value.trim() || text.value.trim()));
    const toForm = () => { foot()?.replaceChildren(status, cancel, save); };
    const askDiscard = () => {
        const keep = btn('btn', 'Keep writing', () => { toForm(); (title.value ? text : title).focus(); }), drop = btn('btn btn-danger', 'Discard', () => pane.closeDetailPane());
        const q = el('span', 'detail-status detail-ask', 'Discard this note?'); q.setAttribute('role', 'alert');
        foot()?.replaceChildren(q, keep, drop); keep.focus();
    };
    const leave = () => { if (dirty()) askDiscard(); else pane.closeDetailPane(); };
    cancel.addEventListener('click', leave);
    const escape = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); leave(); } };
    save.addEventListener('click', async () => {
        const t = title.value.trim(), body = text.value.trim();
        if (!t) { say('Give the note a title.'); title.focus(); return; }
        if (!body) { say('Write the note’s text.'); text.focus(); return; }
        save.disabled = true; cancel.disabled = true; say('Saving…');
        try {
            const r = await teamFetch(team, n => `/api/teams/detail/${encodeURIComponent(n)}/knowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, text: body }) });
            const b = await r.json().catch(() => ({}));
            if (!r.ok || !b.ok) { say(r.status === 409 ? 'A note with this title already exists. Give this one another title.' : `Could not save: ${(b && b.error) || `HTTP ${r.status}`}`); save.disabled = false; cancel.disabled = false; return; }
            onSaved(b.name, !!b.redacted);
        } catch (e) { say(`Could not save: ${e && e.message ? e.message : 'no answer'}`); save.disabled = false; cancel.disabled = false; }
    });
    pane.openDetailPane({
        key: 'new-note', opener, title: 'New note', sub: 'Written by hand', resizable: true, backLabel: 'Knowledge', focus: true,
        body: (host) => {
            const form = el('div', 'knowledge-note-form');
            const l1 = el('label', 'knowledge-note-label', 'Title'); title = el('input', 'field'); title.type = 'text'; title.maxLength = 120; title.autocomplete = 'off'; l1.append(title);
            const l2 = el('label', 'knowledge-note-label', 'Text'); text = el('textarea', 'knowledge-editor'); text.rows = 14; text.maxLength = 20000; l2.append(text);
            title.setAttribute('aria-label', 'Note title'); text.setAttribute('aria-label', 'Note text');
            form.addEventListener('keydown', escape);
            form.append(l1, l2);
            host.replaceChildren(form);
        },
        actions: [{ label: 'Save note', run: () => {} }],
    });
    toForm();
    foot()?.addEventListener('keydown', escape);
    title?.focus();
}
