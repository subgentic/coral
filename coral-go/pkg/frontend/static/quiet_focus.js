/* A dialog that opens with the focus put in it by script (the selected tab of New Agent step 3 and of Restart) must not show a ring round it: the ring is for a person who is using the keyboard (#7391). quietFocus(el)
 * marks the dialog; the first key pressed in the page, or a click, lifts the mark, and Tab then shows the ring as usual. */
let marked = new Set();
export function quietFocus(el) {
    if (!el) return;
    el.setAttribute('data-quiet-focus', '');
    marked.add(el);
}
const lift = () => { if (!marked.size) return; for (const el of marked) el.removeAttribute('data-quiet-focus'); marked = new Set(); };
document.addEventListener('keydown', lift, true);
document.addEventListener('pointerdown', lift, true);
