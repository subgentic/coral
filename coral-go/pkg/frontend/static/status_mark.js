/* One status mark for every list (design guidelines 4.5, #15813): a shape and a word. The word is in the text's own colour; only the shape has colour, so a status is never told by colour alone
 * (it reads the same with colours off: forced-colors keeps the six shapes apart).
 *
 *   state      shape            colour   for
 *   working    filled dot       green    an agent in a turn, a task in progress, a job running
 *   waiting    filled triangle  amber    needs you, blocked on the Operator
 *   idle       hollow dot       grey     idle agent, queued task, proposed goal
 *   sleeping   moon             grey     sleeping agent, a job turned off
 *   done       check            grey     done task, passed run, approved skill
 *   failed     cross            red      failed run, error, terminal gone
 *
 * Blue is never a status. The words are sentence case; a caller passes its own word when the state has a more exact one ("Passed", "Stopped", "Waiting to start"), the default is the state's own.
 * Its rules are in css/status_mark.css, loaded with this module (not at start). Other lists adopt it in their own tasks: statusMark(state, word) returns a node to put in a cell. */
import { loadStyles } from './lazy_styles.js';

await loadStyles('status_mark.css');

const NS = 'http://www.w3.org/2000/svg';
/** The six states: the shape's drawing (a 12 px box), how it is painted, and the word it says by default. */
export const STATUS = {
    working:  { word: 'Working',        paint: 'fill',   d: 'M6 1.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 0 0 0-9Z' },
    waiting:  { word: 'Waiting on you', paint: 'fill',   d: 'M6 1 11.5 10.5H.5Z' },
    idle:     { word: 'Idle',           paint: 'stroke', d: 'M6 2a4 4 0 1 0 0 8a4 4 0 0 0 0-8Z' },
    sleeping: { word: 'Sleeping',       paint: 'fill',   d: 'M9.8 7.6A4.6 4.6 0 0 1 4.4 2.2a4.6 4.6 0 1 0 5.4 5.4Z' },
    done:     { word: 'Done',           paint: 'stroke', d: 'M2 6.5 5 9.5 10.2 3' },
    failed:   { word: 'Failed',         paint: 'stroke', d: 'M2.8 2.8 9.2 9.2M9.2 2.8 2.8 9.2' },
};

/** The mark for one state: <span class="status-mark" data-state="…"><svg class="status-shape" aria-hidden>…</svg><span class="status-word">word</span></span>. The word is the text a screen reader says (the shape is hidden from it). */
export function statusMark(state, word, { title = '' } = {}) {
    const s = STATUS[state];
    if (!s) throw new Error(`status_mark: unknown state "${state}"`);
    const mark = document.createElement('span');
    mark.className = 'status-mark'; mark.dataset.state = state;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'status-shape'); svg.setAttribute('viewBox', '0 0 12 12'); svg.setAttribute('width', '12'); svg.setAttribute('height', '12'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', s.d); path.setAttribute('data-shape', state);
    if (s.paint === 'fill') { path.setAttribute('fill', 'currentColor'); } else { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', state === 'idle' ? '1.5' : '1.8'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); }
    svg.append(path);
    const text = document.createElement('span');
    text.className = 'status-word'; text.textContent = word || s.word;
    mark.append(svg, text);
    if (title) mark.title = title;
    return mark;
}
