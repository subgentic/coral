/* Moved out of tasks.js as it was (#3837): the task list and dialog format helpers; no behaviour change. */
import { formatMonthDayTime, compactCount } from './format.js';

export const _priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
// Priority as the words people choose it by (the create dialog and the CLI), not its sort rank.
export const _priorityLabel = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export function _formatTokenCount(n) {
    if (n == null) return '0';
    return n >= 1000 ? compactCount(n, 'k') : n.toLocaleString();
}

export function _agentTaskStatus(t) {
    if (t.status) return t.status;
    return t.completed === 1 ? 'completed' : t.completed === 2 ? 'in_progress' : t.completed === 3 ? 'skipped' : 'pending';
}

export function formatTaskDate(isoStr) {
    try {
        return formatMonthDayTime(new Date(isoStr));
    } catch {
        return isoStr;
    }
}
