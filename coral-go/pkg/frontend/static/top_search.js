/* The Inbox's search on a phone is the top pill (#13591). Under 640 px the top bar's pill names the view; on an Inbox page with a search box (Needs you, Tasks, Goals, Saved, Chats, Files) it is
 * that page's search field instead, and the box under the tabs is not drawn: the bottom bar already says the person is in the Inbox, and the hamburger beside the pill still opens the views.
 * The page's own box stays in the page (the toolbar builds it, redraws it and keeps its filters), hidden; this field copies what is typed into it and lets its handlers do the rest, so typing,
 * Enter (the Hub's commitOnEnter), the clear button and the saved filters behave as they did. Its name and placeholder are the page box's ("Search needs you"), read again whenever the page redraws. */
const NARROW = '(max-width: 639px)';
let input = null, shown = null, queued = 0;

function pageSearch() {
    if (!window.matchMedia(NARROW).matches) return null;
    const view = document.getElementById('inbox-view');
    if (!view || view.style.display === 'none' || !view.getClientRects().length) return null;
    return [...view.querySelectorAll('.list-bar-search')].find(q => q.closest('.list-bar-search-wrap')) || null;
}

function sync() {
    queued = 0;
    if (!input) return;
    const q = pageSearch();
    if (shown && shown !== q) shown.closest('.list-bar-search-wrap')?.classList.remove('top-searched');
    shown = q;
    document.body.classList.toggle('top-search-on', !!q);
    if (input.hidden !== !q) input.hidden = !q;
    if (!q) return;
    q.closest('.list-bar-search-wrap').classList.add('top-searched');
    const name = q.getAttribute('aria-label') || q.placeholder || 'Search';
    if (input.getAttribute('aria-label') !== name) input.setAttribute('aria-label', name);
    if (input.placeholder !== (q.placeholder || name)) input.placeholder = q.placeholder || name;
    if (document.activeElement !== input && input.value !== q.value) input.value = q.value;
}

function later() { if (!queued) queued = requestAnimationFrame(sync); }

function start() {
    input = document.getElementById('top-search');
    if (!input) return;
    input.addEventListener('input', () => {
        if (!shown) return;
        shown.value = input.value;
        shown.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || !shown) return;
        e.preventDefault();
        shown.value = input.value;
        shown.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: e.repeat, bubbles: true, cancelable: true }));
    });
    const view = document.getElementById('inbox-view');
    if (view) {
        new MutationObserver(later).observe(view, { childList: true, subtree: true });
        new MutationObserver(later).observe(view, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
        view.addEventListener('click', later, true); view.addEventListener('change', later, true);
    }
    window.matchMedia(NARROW).addEventListener('change', later);
    later();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
