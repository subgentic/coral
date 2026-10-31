/* The board's members for the composer: the @ picker's names, the members list and the Operator's subscription (moved out of message_board.js, #8399; no behaviour change). */
import { importOnce } from './import_once.js';
import { fetchSubscribers } from './board_fetch.js';
import { isOperatorId, setBoardMentionNames, highlightMentionsIn, OPERATOR_ID } from './utils.js';
import { setBoardMembers } from './board_search.js';
import { retagMentions } from './board_table.js';
import { isCloud, splitKey, boardFetch } from './server_base.js';

// The team's names for the composer's @ picker (the job title, else the id): refreshed with the members list.
let mentionNames = [];
/** The member a newcomer is told to ask first: the Orchestrator, else the first member; '' while the members are not known. */
export const boardLeadName = () => mentionNames.find(n => n.toLowerCase() === 'orchestrator') || mentionNames[0] || '';

export function attachMentionList() {
    importOnce('./mention_picker.js').then(m => m.attachMentionPicker(document.getElementById('mb-post-input'), () => mentionNames)).catch(() => {}); // the box works without the list
}

export async function loadBoardSubscribers(project) {
    try {
        const subs = await fetchSubscribers(project);
        mentionNames = [...new Set(subs.filter(s => !isOperatorId(s.subscriber_id)).map(s => s.job_title || s.subscriber_id).filter(n => typeof n === 'string' && n))];
        const empty = document.querySelector('#mb-messages .mb-empty-board .mb-empty-ask'); if (empty) { const lead = boardLeadName(); empty.textContent = lead ? `Ask ${lead} to plan the first task` : 'Write the first message'; } // the empty board's button names its lead once the members are in (#11336)
        setBoardMembers([...new Set(subs.map(s => s.job_title || s.subscriber_id).filter(n => typeof n === 'string' && n))].sort().slice(0, 50)); // the From field's names
        // @mentions of these members are highlighted; the bodies on screen are marked in place
        if (setBoardMentionNames(subs.flatMap(s => [s.job_title, s.subscriber_id]))) { highlightMentionsIn(document.getElementById('mb-messages')); retagMentions(document.getElementById('mb-messages'), OPERATOR_ID.toLowerCase()); } // in place: no message is redrawn, so a jump's outline and focus stay
    } catch (e) {
        console.error('Failed to load subscribers:', e);
    }
}

export async function subscribeDashboard(project) {
    try {
        if (isCloud()) {
            const access = await (await importOnce('./server_access.js')).serverAccess(splitKey(project).server);
            if (!access?.mayInteract) return;
        }
        await boardFetch(project, `/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriber_id: OPERATOR_ID, job_title: 'Operator' }),
        });
    } catch (e) {
        // Best effort
    }
}
