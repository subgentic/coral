import { importOnce } from './import_once.js';
// Shared local Live reads (#21030). No timer, remote proxy or enabling request.
const { answeredLocally } = await importOnce('./owner_refusal.js');
let links = [], pending = null, closed = false;
const changed = new Set();
export const liveLinks = () => links;
export const onLiveLinks = fn => { changed.add(fn); return () => changed.delete(fn); };
export const attentionLinks = () => links.filter(l => l.state === 'live' || (l.state === 'paused' && l.paused_reason === 'not_reconfirmed'));
export async function localLiveLinks(team, signal) {
    if (!answeredLocally(team) || closed) return null;
    if (pending) return pending;
    pending = (async () => {
        try {
            const response = await fetch('/api/live/links', { signal });
            if (!response.ok) {
                if (response.status === 404) { closed = true; if (links.length) { links = []; for (const notify of changed) notify(); } }
                return null;
            }
            const data = await response.json();
            if (!Array.isArray(data.links)) return null;
            const different = JSON.stringify(data.links) !== JSON.stringify(links);
            links = data.links;
            if (different) for (const notify of changed) notify();
            return links;
        } catch { return null; }
        finally { pending = null; }
    })();
    return pending;
}

// Display the approved snapshot, never an unconfirmed chat selection.
export const liveChatRole = link => link?.agents?.find(a => a.chat && a.in_view !== false)?.role || '';
export function liveRenewalCopy(link) {
    const role = liveChatRole(link);
    const remaining = Date.parse(link?.reconfirm_due) - Date.now();
    const due = remaining <= 0 ? 'now' : role ? `in ${Math.ceil(remaining / 3600000)} hours` : `in ${Math.ceil(remaining / 86400000)} days`;
    return role ? `Re-confirm due ${due}. One confirmation renews roles, status, task titles, posts and ${role}’s chat together.` : `Re-confirm due ${due}, at the end of this link’s 90-day period. Chat is off. One confirmation renews the whole link.`;
}
export function liveRenewalNotice(link) {
    const role = liveChatRole(link);
    const remaining = Date.parse(link?.reconfirm_due) - Date.now();
    const due = remaining <= 0 ? 'now' : role ? `in ${Math.ceil(remaining / 3600000)} hours` : `in ${Math.ceil(remaining / 86400000)} days`;
    return role ? `Notice: re-confirm this link ${due}. Its seven-day period covers everything it shows. After the due time there is 24 hours of grace, then the entire link pauses.` : `Notice: re-confirm this link ${due}. Its 90-day period covers roster and posts. After the due time there are 14 days of grace, then the entire link pauses.`;
}
