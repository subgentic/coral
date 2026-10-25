/* The detail pane (#7453, UI/UX's one team page): ONE pane for documents, on the right of the page, opened from the rows that are documents (an artifact, a file, a memory file, a knowledge entry); goals, tasks and agents are pages, not
 * this. It is the aside named "Details" in the team page (templates/includes/views/team_page.html): 460 px wide under the header (a 56 px rail of the left sidebar while it is open below 1500 px, a full-screen sheet over a phone),
 * a title (17/700) with one line under it, key facts as a label and a value, the document, and the actions pinned at the bottom, the primary first. Escape and the close button close it and give the focus back to the row that opened it
 * (found again by its key if the table was drawn again meanwhile); choosing another row replaces the content; opening a tab clears it.
 *
 *   openDetailPane({ key, title, sub, facts: [[label, value]], body(el, { signal, isStale }), actions: [{ label, primary, run(button) | href, download }], opener, onClose })
 *   closeDetailPane({ restoreFocus: true })      isDetailOpen()      detailKey()
 * `body` fills the document into an element; it is passed an AbortSignal and a staleness check, and everything it draws is its own (text from an artifact is data: textContent or the sanitising renderers only). */
import { importOnce } from './import_once.js';
const { el } = await importOnce('./team_table.js'); // lazy: its failure is retried
import { trapTab } from './dialog_focus.js';

let current = null; // { key, opener, onClose, abort, gen }
let gen = 0;
let railed = false; // the left sidebar is drawn as its 56 px rail because the pane is open (and was not already)

/** Below 1500 px the sidebar gives its width to the page as the 56 px rail while the pane is open, and comes back when it closes (not saved: the person's own choice stays). */
function rail(open) {
    const layout = document.querySelector('.layout');
    if (!layout) return;
    if (open && !railed && window.innerWidth < 1500 && !layout.classList.contains('sidebar-collapsed')) { layout.classList.add('sidebar-collapsed'); railed = true; }
    else if (!open && railed) { layout.classList.remove('sidebar-collapsed'); railed = false; }
}

const pane = () => document.getElementById('detail-pane');
const page = () => document.getElementById('team-page-view');
const live = (t) => { const s = document.getElementById('team-page-live'); if (s) { s.textContent = ''; s.textContent = t; } };

export const detailKey = () => (current ? current.key : null);

function modalOpen() {
    return !!document.querySelector('dialog[open], .modal[aria-modal="true"]:not([hidden])') && [...document.querySelectorAll('.modal[aria-modal="true"]')].some(m => m.getClientRects().length > 0);
}

export function openDetailPane({ key, title, sub = '', facts = [], body = null, actions = [], opener = null, onClose = null }) {
    const aside = pane();
    if (!aside) return false;
    const replacing = !!current;
    if (current) { current.abort.abort(); }
    const abort = new AbortController();
    const mine = ++gen;
    // Replacing keeps the opener the pane was first opened from, so Escape returns to a row that still exists: the newest row is the one chosen.
    current = { key, opener: opener || (replacing ? current.opener : document.activeElement), onClose, abort, gen: mine };
    aside.replaceChildren();
    const head = el('div', 'detail-head');
    const text = el('div', 'detail-head-text');
    const h = el('h2', 'detail-title', title); h.id = 'detail-pane-title'; h.tabIndex = -1;
    text.append(h);
    if (sub) text.append(el('p', 'detail-sub', sub));
    const close = el('button', 'detail-close');
    close.type = 'button'; close.setAttribute('aria-label', 'Close details');
    close.append(el('span', 'material-icons', 'close')); close.firstChild.setAttribute('aria-hidden', 'true');
    close.addEventListener('click', () => closeDetailPane({ restoreFocus: true }));
    head.append(text, close);
    const main = el('div', 'detail-body');
    if (facts.length) {
        const dl = el('dl', 'detail-facts');
        for (const [k, v] of facts) { if (v == null || v === '') continue; dl.append(el('dt', null, k), el('dd', null, v)); }
        if (dl.children.length) main.append(dl);
    }
    const doc = el('div', 'detail-doc');
    main.append(doc);
    const foot = el('div', 'detail-foot');
    for (const a of actions) {
        let b;
        if (a.href) { b = el('a', `btn${a.primary ? ' btn-primary' : ''}`, a.label); b.href = a.href; b.target = '_blank'; b.rel = 'noopener noreferrer'; if (a.download) b.setAttribute('download', ''); }
        else { b = el('button', `btn${a.primary ? ' btn-primary' : ''}`, a.label); b.type = 'button'; }
        if (a.onclick) b.addEventListener('click', a.onclick);
        if (a.run) b.addEventListener('click', () => a.run(b));
        if (a.ariaLabel) b.setAttribute('aria-label', a.ariaLabel);
        foot.append(b);
    }
    aside.append(head, main);
    if (actions.length) aside.append(foot);
    aside.hidden = false;
    page()?.classList.add('detail-open');
    document.body.classList.add('team-detail-open');
    rail(true);
    if (body) { try { body(doc, { signal: abort.signal, isStale: () => current === null || current.gen !== mine }); } catch (e) { doc.textContent = 'This document could not be shown.'; } }
    h.focus({ preventScroll: true }); // keyboard and screen reader: the pane's title (the row's own button keeps the way back)
    live(`${title}, details`);
    return true;
}

export function closeDetailPane({ restoreFocus = false } = {}) {
    const aside = pane();
    if (!current || !aside) return false;
    const { opener, key, onClose, abort } = current;
    current = null;
    abort.abort();
    aside.hidden = true;
    aside.replaceChildren();
    page()?.classList.remove('detail-open');
    document.body.classList.remove('team-detail-open');
    rail(false);
    if (onClose) { try { onClose(); } catch { /* the pane is closed either way */ } }
    if (restoreFocus) {
        // The row that opened it, or the row with its key when the table was drawn again.
        const again = opener && opener.isConnected ? opener : [...document.querySelectorAll('#team-page-view tr[data-key]')].find(r => r.dataset.key === String(key))?.querySelector('.team-row-btn');
        (again || document.getElementById('team-page-title'))?.focus();
    }
    return true;
}

// Escape closes it (not under a dialog: that one closes first), from the page or the pane.
document.addEventListener('keydown', (e) => {
    if (!current || e.key !== 'Escape' || e.defaultPrevented || modalOpen()) return;
    if (!page() || !page().getClientRects().length) return;
    e.preventDefault();
    closeDetailPane({ restoreFocus: true });
});

// Tab stays in the pane on a phone, where it is a sheet over the page.
document.addEventListener('keydown', (e) => {
    const aside = pane();
    if (!current || e.key !== 'Tab' || !aside || !aside.contains(document.activeElement) || !window.matchMedia('(max-width: 760px)').matches) return;
    trapTab(aside, e);
});
