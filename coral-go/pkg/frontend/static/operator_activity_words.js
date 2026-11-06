/* Activity summaries use recorded fields only; old rows without sender/choice details stay explicit about what is known. */
import { importOnce } from './import_once.js';
const { ACTION_LABEL } = await importOnce('./operator_activity_filters.js');
const TASK_VERB = { task_create: 'created', task_complete: 'completed', task_cancel: 'cancelled', task_publish: 'published', task_edit: 'changed', task_remind: 'sent a reminder about', task_park: 'parked or released', task_reply: 'replied on' };
export function activityWords(row) {
    const quote = row.note ? `: “${row.note}”` : '';
    if (row.action === 'answer' && row.item_kind === 'question') return `You answered ${row.title ? `${row.title}’s question` : 'a question'}${quote}`;
    if (row.action === 'prompt_allow') return `You allowed ${row.title || row.item_id || 'an agent'}’s permission request${quote}`;
    if (row.action === 'prompt_reject') return `You refused ${row.title || row.item_id || 'an agent'}’s permission request${quote}`;
    if (row.action === 'prompt_answer') return `You answered ${row.title || row.item_id || 'an agent'}’s permission prompt${quote}`;
    if (TASK_VERB[row.action]) return `You ${TASK_VERB[row.action]} task #${row.item_id}${row.title ? ` ${row.title}` : ''}${quote}`;
    if (row.action === 'file_edit') return `You saved a new version of ${row.title || 'a file'}${quote}`;
    if (row.action === 'wait_dismiss') return `You dismissed ${row.title || row.item_id || 'an agent'}’s waiting card`;
    if (row.action === 'wait_send') return `You sent held words to ${row.title || row.item_id || 'an agent'}`;
    return `${ACTION_LABEL[row.action] || row.action}${quote}`;
}

/** New job-run records carry the parent job and run id; older bare ids have no safe parent. */
export function jobRunParts(value) {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(String(value || ''));
    if (!match) return null;
    const jobId = Number(match[1]), runId = Number(match[2]);
    return Number.isSafeInteger(jobId) && Number.isSafeInteger(runId) ? { jobId, runId } : null;
}
