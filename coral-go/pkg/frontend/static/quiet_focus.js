/* A dialog that opens with the focus put in it by script (the selected tab of New Agent step 3 and of Restart) must not show a ring round it: the ring is for a person who is using the keyboard (#7391). quietFocus(el)
 * marks the dialog; the first key pressed in the page, or a click, lifts the mark, and Tab then shows the ring as usual. */
let marked = new Set();
// Quiet only for a pointer (#7391): a click just before the dialog opened or moved on gives the quiet start; a key pressed after it (Enter on Next, Enter on the button that opens the dialog) or no input at all (a script opened it) shows the ring from the start,
// as the browser would (WCAG 2.4.7: the ring is hidden only for a pointer start).
let lastKeyAt = 0, lastPointerAt = 0;
document.addEventListener('keydown', () => { lastKeyAt = Date.now(); }, true);
document.addEventListener('pointerdown', () => { lastPointerAt = Date.now(); }, true);
const RECENT_MS = 1500;
export function quietFocus(el) {
    if (!el) return;
    if (Date.now() - lastPointerAt > RECENT_MS || lastKeyAt > lastPointerAt) return;
    el.setAttribute('data-quiet-focus', '');
    marked.add(el);
}
const lift = () => { if (!marked.size) return; for (const el of marked) el.removeAttribute('data-quiet-focus'); marked = new Set(); };
document.addEventListener('keydown', lift, true);
document.addEventListener('pointerdown', lift, true);
