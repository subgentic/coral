import { importOnce } from './import_once.js';
/* Review attention and change labels use server facts, never a guessed age or
 * browser-global read tag as a per-person version baseline (#13916). */
export const waitingOnAgent = row => !!row?.tags?.includes('changes requested');
export const hasNewVersion = row => Number.isSafeInteger(row?.version) && Number.isSafeInteger(row?.opened_version) && row.opened_version > 0 && row.version > row.opened_version;
export const needsReviewAttention = row => (row?.new_comments > 0) || (!waitingOnAgent(row) && (!row?.tags?.includes('read') || hasNewVersion(row)));
export function reviewChangeLabels(row) {
    const labels = [];
    const version = row?.version;
    if (hasNewVersion(row)) labels.push(`New version v${version}`);
    const comments = row?.new_comments;
    if (Number.isSafeInteger(comments) && comments > 0) labels.push(`${comments} new comment${comments === 1 ? '' : 's'}`);
    return labels;
}

/** A file the Operator already decided (approved or denied) that has agent replies in the Operator's thread: it is in Needs you only so the reply is seen (#12097); it is not a request to review again (#16399). */
export const decidedWithNews = row => row?.new_comments > 0 && !!row.tags && (row.tags.includes('approved') || row.tags.includes('denied')) && !row.tags.includes('for review');
export const decidedWord = row => (row?.tags?.includes('denied') ? 'Denied' : 'Approved');

/** A file the Operator sent back (#18701): the time it waited on the agent counts from the decision, not from the upload. */
export const sentBackSince = a => (waitingOnAgent(a) && a.review?.at) || a.created_at;
/** The state chip of a sent-back row: it says the agent has it, in place of "For review". `who` is the agent's name, already made safe by the caller. */
export function sentBackChip(who, archived = false) {
    const chip = document.createElement('span'); chip.className = 'chip inbox-sent-back'; chip.textContent = archived ? `Sent back · ${who} is archived` : `Sent back · waiting on ${who}`;
    chip.title = archived ? 'You asked for changes, but this agent is archived, so nobody is working on it. Start the agent again, or send the file to another agent.' : 'You asked for changes. The row comes back to you when the agent uploads a new version.'; // an archived agent never reads the note (#19897)
    return chip;
}
/** True when the agent that made a sent-back file is archived in the live list: the note was left, but nobody can read it. */
export const producerArchived = (row, live) => !!row?.session_id && (live || []).some(s => s && s.session_id === row.session_id && s.archived);
const _asked = new Map(); // hex -> the words of the Operator's last change request, read once per file
/** One line of what the Operator asked for, read from the file's thread (the Operator's own newest top-level comment, "Changes requested:" cut off). Empty until it arrives, and when there is none. */
export function sentBackExcerpt(row, server, board) {
    const line = document.createElement('span'); line.className = 'inbox-sent-back-ask'; line.hidden = true;
    if (row.new_comments > 0) return line; // reading the thread marks it seen: a row with news keeps its New comments marker until the Operator opens it
    const key = `${row.team}|${row.hex}`;
    if (!_asked.has(key)) _asked.set(key, importOnce('./artifact_comments_api.js').then(m => m.listComments(row.hex, server, board)).then(d => {
        const mine = d.comments.filter(c => c.mine && c.parentId == null && !c.deleted && c.body.trim());
        const last = mine[mine.length - 1];
        return last ? last.body.replace(/^\s*Changes requested:\s*/i, '').replace(/\s+/g, ' ').trim() : '';
    }).catch(() => ''));
    _asked.get(key).then(t => { if (t) { line.textContent = t.length > 140 ? `${t.slice(0, 139)}…` : t; line.title = t; line.hidden = false; } });
    return line;
}
