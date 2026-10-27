/* The Back link of an Inbox task or goal screen says where it goes (#8861, UI/UX): "<- Keep this goal in the Inbox" for a task opened from that goal, "<- Tasks" only when the screen before is the Tasks folder, "<- Goals", "<- Needs you",
 * "<- Artifacts", "<- Board history" likewise; a goal opened from a task says the task. The screen before is read from the history entry (the address the Inbox was at); the title of a goal or task it was opened from is
 * written into the history entry by the opener (go(route, { from })), so it survives a reload and is never taken from a different move. Pure: tested in node. */

const MAX = 24;

/** A title as a Back word: spaces made one, cut at 24 characters with an ellipsis. */
export function shortLabel(s, max = MAX) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim(), chars = [...t];
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : t;
}

/** The title the screen before opened this one with (go(route, { from })), kept in the history entry: '' when there is none or the entry was written some other way. */
export function openedFrom() { return String((history.state && history.state.from) || ''); }

/** The Back word of a `kind` ('task' or 'goal') screen: `prev` is the address before it ('' when unknown), `remembered` the title of the goal or task it was opened from. */
export function backLabelFor(kind, prev, remembered) {
    const p = String(prev || '').split('?')[0].replace(/\/+$/, '');
    const fallback = kind === 'goal' ? 'Goals' : 'Tasks';
    if (!p) return fallback;
    if (p === '/inbox/tasks') return 'Tasks';
    if (p === '/inbox/goals') return 'Goals';
    if (p === '/inbox/needs') return 'Needs you';
    if (p === '/inbox/artifacts') return 'Artifacts';
    if (/^\/inbox\/boards(\/|$)/.test(p)) return 'Board history';
    if (/^\/inbox\/goals\/./.test(p)) return remembered ? shortLabel(remembered) : 'Goal';
    if (/^\/inbox\/tasks\/./.test(p)) return remembered ? shortLabel(remembered) : 'Task';
    return fallback;
}
