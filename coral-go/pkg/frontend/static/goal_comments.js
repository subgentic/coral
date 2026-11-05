/* A goal's Comments tab (#11955): the document comments' panel, pointed at a goal. Nothing here draws a thread: attachComments (artifact_comments.js) does, with the same composer, pictures with Mark up, Resolve and
 * Reopen, and the same agent-reply thread. The goal is the subject (a key goal:<team>:<id> in the place of an artifact's digest), the whole goal is what a comment is on, and the panel is open in the tab
 * instead of a side column or a sheet. The server says who may write (the person at this computer) and decides again on every write. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { contextServer } from './server_base.js';
import { el } from './dom_el.js';
const { attachComments } = await importOnce('./artifact_comments.js');
await loadStyles('goal-comments.css');

/** The thread key of goal `id` on `team`: what the comments routes take where a document has its digest. */
export const goalSubject = (team, id) => `goal:${team}:${id}`;

/** Mount the comments of one goal into `host`. onCount(n) hears how many threads are open. Returns { destroy }. */
export function mountGoalComments(host, { team, goalId, onCount = () => {} }) {
    const box = el('div', 'goal-comments'), body = el('div', 'goal-comments-body'); // body is what attachComments watches for a document; a goal has none, so it stays empty and out of sight
    body.hidden = true;
    box.append(body);
    host.append(box);
    const words = { subject: 'goal', empty: 'No comments yet. Your comment goes to the goal’s owner, who answers here.', whole: 'Comment on this goal', quote: 'This goal' };
    const comments = attachComments(box, body, box, { toggleHost: true, sheet: () => false, shown: () => true, initialOpen: true, preferenceKey: () => null, words, onCount });
    comments.open(goalSubject(team, goalId), contextServer(), team);
    comments.docWhole();
    return { destroy() { comments.close(); box.remove(); } };
}
