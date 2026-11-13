/* Activity rows use recorded fields only; old rows without sender/choice details stay explicit about what is known. A row is a verb (YOU DID), an object (ON) and a detail on its own line (#14423). */
import { importOnce } from './import_once.js';
const { ACTION_LABEL } = await importOnce('./operator_activity_filters.js');
/** New job-run records carry the parent job and run id; older bare ids have no safe parent. */
export function jobRunParts(value) {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(String(value || ''));
    if (!match) return null;
    const jobId = Number(match[1]), runId = Number(match[2]);
    return Number.isSafeInteger(jobId) && Number.isSafeInteger(runId) ? { jobId, runId } : null;
}

// ── One rule for a row (#14423, the Operator): the VERB is in YOU DID, the OBJECT in ON, and the detail on its own line under the object. ──
const FIXED_DISMISS_NOTE = 'Dismissed by the operator'; // what a dismissed ask is recorded with: the verb already says it, so it is not repeated as a detail
const KIND_OBJECT = ['a file', 'a question', 'a goal', 'a proposal', 'a message', 'a task', 'an agent', 'a chat', 'a run', 'a workflow run', 'an automation run', 'a row in Needs you', 'a goal request'];
const TASK_DID = { task_create: 'Created', task_complete: 'Completed', task_cancel: 'Cancelled', task_publish: 'Published', task_edit: 'Changed', task_remind: 'Sent a reminder about', task_park: 'Parked or released', task_reply: 'Replied on' };
/** An answer sent from Needs you starts with the @mention of the agent that asked: it is shown without it, the asker being named on its own. ONLY the recorded asker's mention is removed (its name may be several words, '@Head of Security'), never the first @token of whatever was typed: an answer that starts with another mention keeps it (#14461). With no asker known the note is shown as it is. */
export const cleanAnswer = (note, asker) => {
    const t = String(note || '').trim(), name = String(asker || '').trim();
    if (!name) return t;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), m = new RegExp(`^@${esc.replace(/\s+/g, '\\s+')}(?![\\w-])[\\s,:]*`, 'i').exec(t);
    const rest = m ? t.slice(m[0].length).trim() : t;
    return rest || t;
};
/** @returns {{ did: string, on: string, detail: string }} the verb for YOU DID, the object for ON (what the record kept, else the kind), and the detail for its own line. `itemWords(row)` is the row's own object words (inbox_activity.js). */
export function activityParts(row, itemWords) {
    const p = partsFor(row, itemWords);
    // An action by a Hub guest (not the owner) never reads as the Operator's own: every verb says so (#16098). A chat send already says it in its own words.
    if (isGuestRow(row) && !/^A Hub guest/.test(p.did)) p.did = `A Hub guest: ${p.did}`;
    return p;
}
const isGuestRow = row => /^hub-guest:|^hub:unknown$/.test(String(row.actor || ''));
function partsFor(row, itemWords) {
    const obj = itemWords(row), who = row.title || row.item_id || 'an agent', note = String(row.note || '').trim();
    const mk = (did, on, detail = '') => ({ did, on, detail: detail === FIXED_DISMISS_NOTE ? '' : detail });
    if (row.action === 'answer' && row.item_kind === 'question') { // a NEW row: the title is the ask's line and `asker` is who asked; an older row keeps the asker in the title
        const answer = note ? `Your answer: ${cleanAnswer(note, row.asker || row.title)}` : '';
        if (row.asker) return mk('Answered', String(row.title || '').replace(/^@Operator\b[\s,:]*/i, '').trim() || 'a question', [`from ${row.asker}`, answer].filter(Boolean).join(' · '));
        return mk('Answered', row.title ? `${row.title}’s question` : 'a question', answer);
    }
    if (row.action === 'prompt_allow') return mk('Allowed', `${who}’s permission request`, note);
    if (row.action === 'prompt_reject') return mk('Refused', `${who}’s permission request`, note);
    if (row.action === 'prompt_answer') return mk('Answered', `${who}’s permission prompt`, note);
    if (TASK_DID[row.action]) return mk(TASK_DID[row.action], `task #${row.item_id}${row.title ? ` ${row.title}` : ''}`, note);
    if (row.action === 'file_tags' && row.title) return mk('Changed the tags', obj, note);
    if (row.action === 'file_share') return mk('Shared', obj, note);
    if (row.action === 'file_edit_send') return mk('Sent your edit', `${row.title || 'a file'}`, [note, 'to agents'].filter(Boolean).join(' · '));
    if (row.action === 'file_edit') return mk('Saved a new version', `${row.title || 'a file'}`, note);
    if (row.action === 'wait_dismiss') return mk('Dismissed', `${who}’s waiting card`);
    const guest = row.action === 'chat_send' && isGuestRow(row); // not the Operator's own send (#16039)
    if (row.action === 'chat_send' && row.send_count > 1) return mk(`${guest ? 'A Hub guest sent' : 'Sent'} ${row.send_count} messages to`, obj, row.send_notes.filter(Boolean).slice(0, 5).join(' · ') + (row.send_count > 5 ? ` · and ${row.send_count - 5} more` : ''));
    if (guest) return mk('A Hub guest sent words to', obj, note);
    if (row.action === 'wait_send') return mk('Sent held words to', who);
    let did = ACTION_LABEL[row.action] || row.action;
    const kind = KIND_OBJECT.find(k => did.endsWith(` ${k}`));
    if (kind && obj !== undefined) { const bare = did.slice(0, -(kind.length + 1)); if (!/\b(?:of|to|for|the)$/.test(bare)) did = bare; } // "Starred a file" is Starred | the file
    return mk(did, obj, note);
}

/** The goal and task a row was about, when the record kept them (#14421, S1): "Goal #233 · Threaded Needs you · Task #14390 · Mockups". A task's own row is not told its task again, nor a goal's row its goal; a row from before the record kept them, or about
 *  neither, has none (never guessed). The titles are the ones the server looks up now, so they are words an agent may have written: the caller writes them as text. */
export function aboutWords(row) {
    const goalId = Number(row.goal_id) || 0, taskId = Number(row.task_id) || 0, out = [];
    if (goalId && !(row.item_kind === 'goal' && String(row.item_id) === String(goalId))) out.push(`Goal #${goalId}${row.goal_title ? ` \u00b7 ${row.goal_title}` : ''}`);
    if (taskId && !(row.item_kind === 'task' && String(row.item_id) === String(taskId))) out.push(`Task #${taskId}${row.task_title ? ` \u00b7 ${row.task_title}` : ''}`);
    return out.join(' \u00b7 ');
}

/** Sends one after another to the same agent from the same place read as one row (#16000): the newest row, with how many and the first line of each (newest first). Only rows next to each other in the list join. */
export function collapseSends(list) {
    const out = [];
    for (const r of list) {
        const last = out[out.length - 1];
        if (r.action === 'chat_send' && last && last.action === 'chat_send' && last.item_id === r.item_id && last.source === r.source && last.actor === r.actor) {
            last.send_count = (last.send_count || 1) + 1; last.send_notes.push(String(r.note || '').trim());
        } else out.push(r.action === 'chat_send' ? { ...r, send_notes: [String(r.note || '').trim()] } : r);
    }
    return out;
}
