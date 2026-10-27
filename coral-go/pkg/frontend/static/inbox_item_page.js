// Inbox owns the navigation shell; the task and Board retain their existing renderers.
import { importOnce } from './import_once.js';
import { build, keyRoute } from './routes.js';
import { keyLabel } from './server_base.js';
import { go } from './nav.js';
const el = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; };

export function mountInboxItem(host, { kind, team, id, back, onChanged, backLabel = '' }) {
    let disposed = false, leaveBoard = null;
    const task = kind === 'tasks';
    const teamURL = build(keyRoute('team', team, task ? 'tasks' : 'messages', task ? id : null));
    const backButton = () => {
        const b = el('button', 'back-link goals-back', `← ${backLabel || (task ? 'Tasks' : 'Board history')}`); b.type = 'button'; b.addEventListener('click', back); return b;
    };
    const links = () => {
        const row = el('div', 'goal-back-row'), link = el('a', 'goal-team-link inbox-team-link', 'Open on team page');
        link.href = teamURL; link.setAttribute('data-route', ''); link.setAttribute('aria-label', `Open ${keyLabel(team)} on team page`);
        row.append(backButton(), link); return row;
    };
    async function load() {
        host.replaceChildren(links(), el('p', 'goals-note', 'Loading…'));
        try {
            if (task) {
                const m = await importOnce('./team_tasks_page.js');
                const full = await m.readTask(team, id);
                if (disposed) return;
                if (!full) throw new Error('This task could not be read.');
                m.renderTaskPage(host, full, { project: team, backLabel: backLabel || 'Tasks', onBack: back, onChanged, teamLink: teamURL,
                    openGoal: goal => go({ view: 'inbox-goals', sub: 'goals', id: team, item: Number(goal) }, { from: `#${full.id} ${full.title}` }), // the goal opens in the Inbox, Back returns to the task (#8861)
                    openTask: t => go({ view: 'inbox-tasks', sub: 'tasks', id: team, item: t.id }, { from: `#${full.id} ${full.title}` }),
                });
            } else {
                const m = await importOnce('./message_board.js');
                if (disposed) return;
                const head = el('div', 'inbox-board-head'), title = el('h2', 'goals-detail-title', keyLabel(team));
                title.tabIndex = -1; head.append(links(), title);
                const board = el('div', 'team-panel inbox-board-body'); host.replaceChildren(head, board);
                m.showBoardInPage(team, board);
                leaveBoard = () => { if (board.contains(document.getElementById('mb-board'))) m.leaveBoardPage(); };
                title.focus({ preventScroll: true });
            }
        } catch (error) {
            if (disposed) return;
            const retry = el('button', 'btn', 'Try again'); retry.type = 'button'; retry.addEventListener('click', load);
            host.replaceChildren(links(), el('p', 'goals-note', error.message || 'This item could not be read.'), retry);
        }
    }
    load();
    return { dispose() {
        disposed = true;
        host._taskConversation?.destroy({ keepDrafts: true }); host._taskConversation = null;
        leaveBoard?.(); host.replaceChildren();
    } };
}
