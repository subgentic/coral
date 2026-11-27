/* "task #1234" in an agent's chat or a board message is a link to that task on the agent's team, and "goal #257" a link to that goal (#21818; a bare "#1234" stays text, the Operator's call). Loaded the first time a bubble has such a number (chat_bubbles.js).
 * A number is not looked up at render: the link opens the task (or goal) page, which says when there is no such one. Text in code, a link or a button is left as it is; so is a number inside a word, a path or a URL. */
import { loadStyles } from './lazy_styles.js';
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { boardTeamKey, currentServer } from './server_base.js';
await loadStyles('chat_task_refs.css');

const REF = /(?<![\w#/&:.-])(task|goal)\s+#([1-9]\d{2,8})(?![\w-])/gi;
const SKIP = 'a, button, code, pre, kbd, samp, script, style, [data-file-ref]';

/** Turn the task and goal numbers in root's text into links on `team` (a board name or team key; default: the open agent's) of `server`. Returns root. */
export function linkTaskRefs(root, team = state.currentSession?.board_project, server = currentServer()) {
    if (!root || !team) return root;
    const nodes = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes('#') && !n.parentElement.closest(SKIP)) nodes.push(n);
    for (const n of nodes) {
        const frag = document.createDocumentFragment(); let at = 0;
        for (const m of n.nodeValue.matchAll(REF)) {
            const a = document.createElement('a'), goal = m[1].toLowerCase() === 'goal';
            a.className = 'chat-task-ref'; a.href = '#'; a.textContent = m[0];
            a.dataset.kind = goal ? 'goal' : 'task'; a.dataset.id = m[2]; a.dataset.team = team; a.dataset.server = server;
            a.title = `Open ${goal ? 'goal' : 'task'} #${m[2]}`;
            frag.append(n.nodeValue.slice(at, m.index), a); at = m.index + m[0].length;
        }
        if (at) { frag.append(n.nodeValue.slice(at)); n.replaceWith(frag); }
    }
    return root;
}

/** The message bodies in root (a board's messages box, or one body) on `board`. */
export const linkBoardRefs = (root, board, server) => (root.matches('.mb-message-body') ? [root] : root.querySelectorAll('.mb-message-body')).forEach(b => linkTaskRefs(b, board, server));

document.addEventListener('click', async e => {
    const a = e.target.closest?.('a.chat-task-ref');
    if (!a || e.defaultPrevented || e.button !== 0) return;
    e.preventDefault();
    const goal = a.dataset.kind === 'goal', { go } = await importOnce('./nav.js');
    go({ view: goal ? 'inbox-goals' : 'inbox-tasks', sub: goal ? 'goals' : 'tasks', id: boardTeamKey(a.dataset.server, a.dataset.team), item: Number(a.dataset.id) });
});
