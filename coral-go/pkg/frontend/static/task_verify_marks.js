/* Verification stays in the task detail; dock rows contain only status, title and avatar (#8792). */
import { escapeHtml } from './utils.js';
import { verificationOf } from './task_verification.js';
import { formatTaskDate } from './task_format.js';

/** The task detail's one plain muted line: who verified it, or that evidence is attached; nothing for an unverified task. */
export function _verifyLine(t) {
    const v = verificationOf(t, formatTaskDate);
    return v && v.line ? `<div class="task-detail-verification">${escapeHtml(v.line)}</div>` : '';
}
