// The review size guard's warning on a task that is in review (#21027): shown only when the team's setting is on and the diff is over a limit. A warning, never a block. The verdict is GET
// /api/board/{project}/tasks/{id}/review-size: {applies, over, lines, files, skipped_lines, skipped_files, limit_lines, limit_files}; no setting, no diff (404) or a refusal draw nothing.
import { boardFetch, pathId } from './server_base.js';
import { loadStyles } from './lazy_styles.js';

const n = v => Number(v || 0).toLocaleString('en-US');
const plural = (count, one, many) => `${n(count)} ${Number(count) === 1 ? one : many}`;

/** The sentences of the banner, from the verdict's own numbers. */
export function reviewSizeWords(v) {
    const limits = [v.limit_lines > 0 && plural(v.limit_lines, 'line', 'lines'), v.limit_files > 0 && plural(v.limit_files, 'file', 'files')].filter(Boolean).join(' or ');
    const skipped = v.skipped_files > 0 || v.skipped_lines > 0 ? ` ${plural(v.skipped_lines, 'line', 'lines')} in ${plural(v.skipped_files, 'skipped path', 'skipped paths')} ${v.skipped_lines === 1 && v.skipped_files === 1 ? 'is' : 'are'} not counted.` : '';
    return { lead: 'Large change.', text: ` ${plural(v.lines, 'line', 'lines')} in ${plural(v.files, 'file', 'files')}; your team's limit is ${limits}.${skipped}`, note: 'This is a warning only. You can still review and approve it.' };
}

/** The banner node for a verdict, or null when there is nothing to warn about. */
export function reviewSizeBanner(v) {
    if (!v || v.applies !== true || v.over !== true) return null;
    const w = reviewSizeWords(v);
    const box = document.createElement('div'); box.className = 'notice notice-warn review-size-banner'; box.setAttribute('role', 'status');
    const icon = document.createElement('span'); icon.className = 'material-icons'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = 'warning';
    const body = document.createElement('div');
    const lead = document.createElement('b'); lead.textContent = w.lead;
    const text = document.createTextNode(w.text);
    const note = document.createElement('div'); note.className = 'review-size-note'; note.textContent = w.note;
    body.append(lead, text, note); box.append(icon, body);
    return box;
}

/** Reads the verdict for a task and puts the banner before the task's facts (the third argument) when the change is over the limit. Never throws: a task with no diff, a refusal or a failed read shows nothing. */
export async function showReviewSize(project, task, anchor) {
    try {
        const r = await boardFetch(project, `/tasks/${pathId(task.id)}/review-size`);
        if (!r.ok) return;
        const banner = reviewSizeBanner(await r.json());
        if (!banner || !anchor.isConnected) return;
        await loadStyles('task_review_size.css');
        if (anchor.isConnected && !anchor.parentNode.querySelector(':scope > .review-size-banner')) anchor.before(banner);
    } catch { /* a warning is only extra: the page works without it */ }
}
