/* A launch whose name is an archived member's of that team (#19674): Coral answers 409 name_archived with the member, its session and a free name. The person chooses: Start it (its history and tasks come back) or Use another
 * name (the name box gets the suggestion, to edit). Nothing is launched by either; Start wakes the archived member. */
import { showConfirmModal } from './confirm_dialog.js';
import { toggleAgentSleep } from './agent_actions.js';
import { state } from './state.js';

/** Resolves to the started member as a launch answer ({ session_id, session_name }) after Start it, or null (Use another name, Escape). */
export function nameArchivedChoice(data, server, nameInput) {
    const member = String(data.member || 'that agent');
    return new Promise(resolve => {
        showConfirmModal(`An archived agent named ${member} is on this team`, 'Start it, and its history and tasks come back. Or give this new agent another name.',
            async () => {
                const ok = await toggleAgentSleep(member, '', data.session_id, 'wake');
                const row = (state.liveSessions || []).find(s => s.session_id === data.session_id);
                resolve(ok ? { session_id: data.session_id, session_name: row ? row.name : member } : null);
            },
            () => {
                if (nameInput && data.suggested_name) { nameInput.value = data.suggested_name; nameInput.focus(); nameInput.select(); }
                resolve(null);
            },
            { danger: false, label: 'Start it', cancelLabel: 'Use another name' });
    });
}
