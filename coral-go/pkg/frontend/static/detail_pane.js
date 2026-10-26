/* The detail pane (#7453, UI/UX's one team page): ONE pane for documents, on the right of the page, opened from the rows that are documents (an artifact, a file, a memory file, a knowledge entry); goals, tasks and agents are pages, not
 * this. It is the aside named "Details" in the team page (templates/includes/views/team_page.html): 460 px wide under the header (a 56 px rail of the left sidebar while it is open below 1500 px, a full-screen sheet over a phone),
 * a title (17/700) with one line under it, key facts as a label and a value, the document, and the actions pinned at the bottom, the primary first. Escape and the close button close it and give the focus back to the row that opened it
 * (found again by its key if the table was drawn again meanwhile); choosing another row replaces the content; opening a tab clears it.
 *
 *   openDetailPane({ key, title, sub, facts: [[label, value]], extra: node (under the title row), body(el, { signal, isStale }), actions: [{ label, primary, run(button) | href, download }], opener, onClose, resizable, backLabel, focus, focusClose, subTitle, details })
 *   Content first (#7775): facts: [[label, value]] and whatever `details(h, { isStale })` adds through h.add(node) / h.clear() are behind ONE closed "Details" button in the header row (details_disclosure.js); the document comes straight under the header.
 *   resizable: the pane is a right sidebar like a goal page's task column (#7702): a handle on its left edge, dragged or moved with the keys, the width remembered (dock_resize.js). backLabel: the phone's way back ("Knowledge" -> "<- Knowledge"), shown only where the pane is a sheet. focus: false leaves the focus where it is (the pane opened by itself).
 *   closeDetailPane({ restoreFocus: true })      isDetailOpen()      detailKey()
 * `body` fills the document into an element; it is passed an AbortSignal and a staleness check, and everything it draws is its own (text from an artifact is data: textContent or the sanitising renderers only). */
import { importOnce } from './import_once.js';
const { el } = await importOnce('./team_table.js'); // lazy: its failure is retried
const { attachDockResize, DOCK_MIN_WIDTH, dockMaxWidth } = await importOnce('./dock_resize.js'); // the goal page column's resize
const { foldWayBack } = await importOnce('./way_back.js');
const { makeDetails } = await importOnce('./details_disclosure.js'); // the facts and more behind one Details button (#7775)
import { trapTab } from './dialog_focus.js';

let current = null; // { key, opener, onClose, abort, gen }
let gen = 0;
let railed = false; // the left sidebar is drawn as its 56 px rail because the pane is open (and was not already)

/** Below 1500 px the sidebar gives its width to the page as the 56 px rail while the pane is open, and comes back when it closes (not saved: the person's own choice stays). */
// The pane is a sheet over the page, as on a phone, when the window holds fewer than 48 em (a phone, or a larger text size): beside the page it would leave neither of them room, and the sidebar is not squeezed to a rail.
const asSheet = () => window.innerWidth <= 760 || window.innerWidth / (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) < 48;
function rail(open) {
    const layout = document.querySelector('.layout');
    if (!layout) return;
    if (open && !railed && !asSheet() && window.innerWidth < 1500 && !layout.classList.contains('sidebar-collapsed')) { layout.classList.add('sidebar-collapsed'); railed = true; }
    else if (!open && railed) { layout.classList.remove('sidebar-collapsed'); railed = false; }
}

const pane = () => document.getElementById('detail-pane');
const page = () => document.getElementById('team-page-view');
const live = (t) => { const s = document.getElementById('team-page-live'); if (s) { s.textContent = ''; s.textContent = t; } };

export const detailKey = () => (current ? current.key : null);

function modalOpen() {
    return !!document.querySelector('dialog[open]') || [...document.querySelectorAll('.modal[aria-modal="true"]:not([hidden])')].some(m => m.getClientRects().length > 0); // a native dialog (the reminder, the confirmation) closes first on Escape
}

/** The resize handle on the pane's left edge: the goal page's handle (goals_view.js) for this pane, with the same limits, keys and double click. */
function addResizeHandle(aside) {
    const row = document.getElementById('team-page-row');
    if (!row) return;
    const grip = el('div', 'detail-grip');
    grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical'); grip.setAttribute('aria-label', 'Resize the details'); grip.tabIndex = 0; grip.title = 'Drag to resize, double click to reset';
    const value = () => { grip.setAttribute('aria-valuemin', String(DOCK_MIN_WIDTH)); grip.setAttribute('aria-valuemax', String(dockMaxWidth(row))); grip.setAttribute('aria-valuenow', String(Math.round(aside.getBoundingClientRect().width))); };
    aside.append(grip);
    attachDockResize(grip, { panel: aside, row, key: 'coral-detail-width', apply: (w) => { aside.style.setProperty('--detail-w', w ? `${w}px` : ''); value(); } }).restore();
}

export function openDetailPane({ key, title, sub = '', facts = [], body = null, actions = [], opener = null, onClose = null, host = null, resizable = false, backLabel = '', focus = true, focusClose = false, subTitle = '', details = null, extra = null }) {
    const aside = host || pane(); // host: a pane of its own, a sheet over a panel (the agent's Artifacts), not the team page's aside
    if (!aside) return false;
    if (current && current.aside !== aside) closeDetailPane(); // one document at a time: the other pane is put away
    const replacing = !!current;
    if (current) { current.abort.abort(); }
    const abort = new AbortController();
    const mine = ++gen;
    // Replacing keeps the opener the pane was first opened from, so Escape returns to a row that still exists: the newest row is the one chosen.
    current = { key, opener: opener || (replacing ? current.opener : document.activeElement), onClose, abort, gen: mine, aside, hosted: !!host };
    aside.replaceChildren();
    const more = makeDetails(); // the facts and the rest: one closed button in the header row, the document straight under the header
    const head = el('div', 'detail-head');
    const text = el('div', 'detail-head-text');
    if (backLabel && (!host || host.classList.contains('inbox-detail-pane'))) { // the phone's way back (the Inbox's pane has its own host, and a way back like the team page's): a text link named for where it goes, on the title's line (#7734); a pane that is not a sheet has the close button
        const back = el('button', 'goals-back detail-back'); back.type = 'button';
        const arrow = el('span', 'goals-back-arrow', '\u2190'); arrow.setAttribute('aria-hidden', 'true');
        back.append(arrow, document.createTextNode(` ${backLabel}`));
        back.addEventListener('click', () => closeDetailPane({ restoreFocus: true }));
        text.append(back);
    }
    const h = el('h2', 'detail-title', title); h.id = 'detail-pane-title'; h.tabIndex = -1;
    text.append(h);
    const subRow = el('div', 'detail-sub-row'); // the one line under the title: its facts in words, and the Details button at its end (nothing taller than the line)
    if (sub) { const p = el('p', 'detail-sub', sub); if (subTitle) p.title = subTitle; subRow.append(p); } // subTitle: the exact time behind a time in words
    subRow.append(more.button);
    text.append(subRow);
    if (extra) text.append(extra); // a line of the caller's own under the title row (an artifact's tags, #8594)
    if (backLabel && (!host || host.classList.contains('inbox-detail-pane'))) foldWayBack(text, '.detail-back', '.detail-title');
    const close = el('button', 'detail-close');
    close.type = 'button'; close.setAttribute('aria-label', 'Close details');
    close.append(el('span', 'material-icons', 'close')); close.firstChild.setAttribute('aria-hidden', 'true');
    close.addEventListener('click', () => closeDetailPane({ restoreFocus: true }));
    head.append(text, close);
    const main = el('div', 'detail-body');
    if (facts.length) {
        const dl = el('dl', 'detail-facts');
        for (const [k, v] of facts) { if (v == null || v === '') continue; dl.append(el('dt', null, k), el('dd', null, v)); }
        if (dl.children.length) more.add(dl);
    }
    const doc = el('div', 'detail-doc');
    main.append(doc);
    const foot = el('div', 'detail-foot');
    const rank = a => (a.danger ? 0 : a.primary ? 2 : 1); // the bar's one order: a danger button first (at the left edge), the primary last (#7684)
    for (const a of [...actions].sort((x, y) => rank(x) - rank(y))) {
        let b;
        if (a.href) { b = el('a', `btn${a.primary ? ' btn-primary' : ''}`, a.label); b.href = a.href; b.target = '_blank'; b.rel = 'noopener noreferrer'; if (a.download) b.setAttribute('download', ''); }
        else { b = el('button', `btn${a.primary ? ' btn-primary' : ''}`, a.label); b.type = 'button'; }
        if (a.onclick) b.addEventListener('click', a.onclick);
        if (a.run) b.addEventListener('click', () => a.run(b));
        if (a.ariaLabel) b.setAttribute('aria-label', a.ariaLabel);
        if (a.title) b.title = a.title;
        if (a.pressed !== undefined) b.setAttribute('aria-pressed', String(a.pressed)); // a toggle (Keep)
        if (a.danger) b.classList.add('btn-danger'); // a destructive button in a bar is a button with an edge, the delete confirmation's class (UI/UX), never bare text
        foot.append(b);
    }
    aside.append(head, more.panel, main);
    if (actions.length) aside.append(foot);
    if (resizable && !host) addResizeHandle(aside); else aside.style.removeProperty('--detail-w'); // a pane that is not resizable has its own width, not the last one's
    aside.hidden = false;
    if (!host) {
        page()?.classList.add('detail-open');
        page()?.classList.toggle('detail-sheet', asSheet());
        document.body.classList.add('team-detail-open');
        rail(true);
    }
    if (details) { try { details({ add: more.add, remove: more.remove, onShown: more.onShown, clear: more.clear }, { isStale: () => current === null || current.gen !== mine }); } catch { /* the pane is shown without them */ } }
    if (body) { try { body(doc, { signal: abort.signal, isStale: () => current === null || current.gen !== mine }); } catch (e) { doc.textContent = 'This document could not be shown.'; } }
    if (focus) (focusClose ? close : h).focus({ preventScroll: true }); // keyboard and screen reader: the pane's title (the row's own button keeps the way back); focusClose: its close button, so no ring is drawn round words (#7404)
    live(`${title}, details`);
    return true;
}

export function closeDetailPane({ restoreFocus = false } = {}) {
    if (!current) return false;
    const { opener, key, onClose, abort, aside, hosted } = current;
    current = null;
    abort.abort();
    aside.hidden = true;
    aside.replaceChildren();
    if (!hosted) {
        page()?.classList.remove('detail-open', 'detail-sheet');
        document.body.classList.remove('team-detail-open');
        rail(false);
    }
    if (onClose) { try { onClose(); } catch { /* the pane is closed either way */ } }
    if (restoreFocus) {
        // The row that opened it, or the row with its key when the table was drawn again.
        const again = opener && opener.isConnected ? opener : [...document.querySelectorAll(hosted ? '#agentic-panel-artifacts tr[data-key]' : '#team-page-view tr[data-key]')].find(r => r.dataset.key === String(key))?.querySelector('.dt-primary');
        (again || (hosted ? null : document.getElementById('team-page-title')))?.focus();
    }
    return true;
}

// Escape closes it (not under a dialog: that one closes first), from the page or the pane.
document.addEventListener('keydown', (e) => {
    if (!current || e.key !== 'Escape' || e.defaultPrevented || modalOpen()) return;
    if (current.hosted ? !current.aside.getClientRects().length : (!page() || !page().getClientRects().length)) return;
    e.preventDefault();
    closeDetailPane({ restoreFocus: true });
});

// Tab stays in the pane on a phone, where it is a sheet over the page.
document.addEventListener('keydown', (e) => {
    const aside = current && current.aside;
    if (!current || e.key !== 'Tab' || !aside || !aside.contains(document.activeElement) || !(current.hosted || window.matchMedia('(max-width: 760px)').matches)) return;
    trapTab(aside, e);
});
