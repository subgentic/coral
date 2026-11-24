import { importOnce } from './import_once.js';
// Shared local Live reads (#21030). No timer, remote proxy or enabling request.
const { answeredLocally } = await importOnce('./owner_refusal.js');
let links = [], pending = null;
const changed = new Set();
export const liveLinks = () => links;
export const onLiveLinks = fn => { changed.add(fn); return () => changed.delete(fn); };
export const attentionLinks = () => links.filter(l => l.state === 'live' || (l.state === 'paused' && l.paused_reason === 'not_reconfirmed'));
export async function localLiveLinks(team, signal) {
    if (!answeredLocally(team)) return null;
    if (pending) return pending;
    pending = (async () => {
        try {
            const response = await fetch('/api/live/links', { signal });
            if (!response.ok) {
                if (response.status === 404 && links.length) { links = []; for (const notify of changed) notify(); }
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
