/* Which teams are archived (#21850), by team key. The projects list says it (archived, archived_at on each team: fetchProjects notes it here); Archive team and Restore team set it at once. Lazy: loaded by the
   Teams page, the team page and the archive module, not at start. The sidebar does not use it: the live list's rows carry team_archived. */
import { splitKey, identityKey } from './server_base.js';

const at = new Map(); // team key -> when it was archived ('' when unknown)
const kept = new Map(); // team key -> how many goals the archived team keeps (the projects list says it, #21924)

export const goalsKept = key => kept.get(String(key ?? '')) || 0;

export const isArchived = key => at.has(String(key ?? ''));

export function setArchived(key, on, when = '') {
    const k = String(key ?? '');
    if (!k || on === at.has(k)) return;
    if (on) at.set(k, when); else at.delete(k);
    document.dispatchEvent(new CustomEvent('coral:team-archived-changed', { detail: { team: k, archived: on } }));
}

/** What a projects list says: each team's archived flag, from the rows of `server` (rows of this computer carry bare names). */
export function noteArchivedRows(rows, server = null) {
    for (const p of Array.isArray(rows) ? rows : []) {
        if (!p || !p.project) continue;
        const key = server && server !== 'local' ? identityKey(server, splitKey(p.project).name) : String(p.project);
        if (p.archived && p.goals_kept) kept.set(key, p.goals_kept); else kept.delete(key);
        setArchived(key, !!p.archived, p.archived_at || '');
    }
}
