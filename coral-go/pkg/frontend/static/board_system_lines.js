/* Board chat: the task queue's own lines (#3343).
   Every task posts "New Task", "claimed", "completed"… lines as "Coral Task Queue", so on a
   busy board they bury what people and agents wrote. In the chat, each run of consecutive
   task-queue lines is one muted row ("3 task updates · #3343 claimed by Backend Dev · …")
   that is open by default and can be closed (#11585). Only the display changes: the messages, and the @mention
   notifications they carry, are exactly as before. In select mode nothing is collapsed, so
   each line can still be selected. */

import { escapeHtml, escapeAttr } from './utils.js';
import { queueRunWords, queueLineWords } from './board_queue_words.js';
import { bs } from './board_state.js';
import { browserLocal } from './safe_storage.js';

 const TASK_QUEUE_SENDER = 'Coral Task Queue';

 function isTaskQueueMessage(m) {
    if (!m) return false;
    // The server sets is_system for its own posts (#3387); a name alone is never trusted.
    return m.is_system === true && m.subscriber_id === TASK_QUEUE_SENDER;
}

/** Splits messages into items: {kind:'msg', m} or {kind:'queue', key, msgs} for each run
 *  of consecutive task-queue lines. collapse=false keeps every message as its own item. */
export function groupTaskQueueRuns(messages, collapse = true) {
    const items = [];
    for (const m of messages) {
        if (collapse && isTaskQueueMessage(m)) {
            const last = items[items.length - 1];
            if (last && last.kind === 'queue') { last.msgs.push(m); continue; }
            items.push({ kind: 'queue', key: String(m.id), msgs: [m] });
            continue;
        }
        items.push({ kind: 'msg', m });
    }
    return items;
}

// "[Task #3343 claimed by Backend Dev] Board chat: …" -> "Task #3343 claimed by Backend Dev"
function summaryOf(content) {
    const text = String(content || '').replace(/^(@\S+\s+)+/, '');
    const bracket = text.match(/\[([^\]]{1,120})\]/);
    return (bracket ? bracket[1] : text.split('\n')[0]).trim().slice(0, 120);
}

// A run is open by default (#11585, the operator: people like to see what shows up); a person can close it, and the board remembers the choice (the last one they made on that board) for the runs
// that come after. A run they opened or closed themselves keeps that across re-renders (the chat re-renders on every poll), remembered by its messages' ids so a row that grows stays as it was.
const openIds = new Set(), closedIds = new Set();
const prefKey = () => `coral.queueRunsOpen.${bs.currentProject || ''}`;

// One capture listener on the summary's click (a key press on it is a click too), not on 'toggle': a run drawn open fires 'toggle' by itself, which is not a choice. Not an inline handler: the Coral Hub's CSP strips them.
document.addEventListener('click', (e) => {
    const d = e.target instanceof Element && e.target.closest('summary.mb-queue-summary')?.parentElement;
    if (!d || !d.matches('details.mb-queue-run')) return;
    const next = !d.open; // the click has not toggled it yet
    browserLocal.set(prefKey(), next ? '1' : '0');
    for (const line of d.querySelectorAll('.mb-queue-line')) { (next ? openIds : closedIds).add(line.dataset.messageId); (next ? closedIds : openIds).delete(line.dataset.messageId); }
}, true);

/** One collapsed row for a run of task-queue lines. formatTime formats created_at. */
export function renderTaskQueueRun(item, formatTime) {
    const label = queueRunWords(item.msgs.map(m => m.content)) || summaryOf(item.msgs[0] && item.msgs[0].content); // what happened, in words (#7183): never the lines' command text
    const lines = item.msgs.map(m => {
        const w = queueLineWords(m.content), words = `${w.head}${w.rest}`; // the line's own text is an instruction to an agent: the person reads what happened, and the task opens from here (#10722)
        const head = w.id ? `<button type="button" class="cni-link mb-queue-task" data-on-click="mb-task-open" data-task-id="${Number(w.id)}">${escapeHtml(w.head)}</button>` : escapeHtml(w.head);
        return `
            <div class="mb-queue-line" data-message-id="${escapeAttr(String(m.id))}">
                <span class="mb-queue-time">${escapeHtml(formatTime(m.created_at))}</span>
                <span class="mb-queue-text" title="${escapeAttr(words)}">${head}${escapeHtml(w.rest)}</span>
            </div>`;
    }).join('');
    const open = item.msgs.some(m => openIds.has(String(m.id))) || (!item.msgs.some(m => closedIds.has(String(m.id))) && browserLocal.get(prefKey()) !== '0');
    for (const m of item.msgs) (open ? openIds : closedIds).add(String(m.id)); // drawn once, a run keeps how it was drawn: the board's choice is for the runs that come after
    return `<details class="mb-queue-run" role="listitem" data-queue-run="${escapeAttr(item.key)}"${open ? ' open' : ''}>
        <summary class="mb-queue-summary" title="Task queue updates">
            <span class="mb-queue-icon" aria-hidden="true">⚙</span>
            <span class="mb-queue-label">${escapeHtml(label)}</span>
        </summary>${lines}
    </details>`;
}
