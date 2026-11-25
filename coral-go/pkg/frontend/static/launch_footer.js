/* The launch dialog's footer on a desktop (#18795, the Operator: "the up arrow to show more detail is too hidden"): the recap line (New agent) or the reason line (New team) sits on the footer's own row, at the left,
 * with the buttons at the right, and New agent's recap ends in a "More ▴" link that opens the detail. A phone keeps its own layout (the line above the buttons, its arrow at the right). Lazy, with its stylesheet:
 * the start carries none of it. The row is measured, not guessed: the buttons shown (Back, Cancel, Next, Launch, Remove from team...) change with the step. */
import { loadStyles } from './lazy_styles.js';
await loadStyles('launch_footer.css');

const DESKTOP = '(min-width: 768px)';
const STEPS = ['launch-step-agent', 'launch-step-team'];

/** Say where the buttons begin, so the line stops short of them and is as tall as the footer row. */
export function fitFooter(id) {
    const step = document.getElementById(id), actions = step?.querySelector(':scope > .modal-actions');
    if (!step || !actions) return;
    if (!matchMedia(DESKTOP).matches) { step.style.removeProperty('--lf-right'); step.style.removeProperty('--lf-h'); step.style.removeProperty('--lf-left'); return; }
    const box = actions.getBoundingClientRect(), shown = [...actions.querySelectorAll(':scope > .btn')].filter(b => !b.hidden && b.getClientRects().length);
    if (!box.width || !shown.length) return;
    // New team keeps Cancel at the row's far left and Back / Launch team at the right (#21236): the line runs between the two groups, not under Cancel (counting Cancel made the line 24 px wide)
    const mid = box.left + box.width / 2, rects = shown.map(b => b.getBoundingClientRect()), right = rects.filter(r => r.left + r.width / 2 > mid), left = rects.filter(r => r.left + r.width / 2 <= mid), stepLeft = step.getBoundingClientRect().left;
    step.style.setProperty('--lf-right', `${Math.round(box.right - Math.min(...(right.length ? right : rects).map(r => r.left)) + 16)}px`);
    if (right.length && left.length) step.style.setProperty('--lf-left', `${Math.round(Math.max(...left.map(r => r.right)) - stepLeft + 12)}px`); else step.style.removeProperty('--lf-left');
    step.style.setProperty('--lf-h', `${Math.round(box.height)}px`);
}

let wired = false;
if (!wired) { wired = true; window.addEventListener('resize', () => STEPS.forEach(fitFooter)); }
