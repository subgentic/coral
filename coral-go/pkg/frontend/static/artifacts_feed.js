/* Artifact revisions are freshness hints. Missing fields on older servers keep
 * the existing timed reads; only an explicit matching token can skip a list. */
import { boardFetch } from './server_base.js';
const revisions = new Map(), listeners = new Set();
export const artifactRevision = value => Number.isSafeInteger(value) && value > 0 ? value : null;
export function publishArtifactsRev(brief, reconnect = false) {
    if (reconnect) for (const fn of [...listeners]) fn(null, null, true);
    if (!brief || typeof brief !== 'object') return;
    for (const [team, raw] of Object.entries(brief)) {
        const rev = artifactRevision(raw);
        if (rev === null) continue;
        const before = revisions.get(team);
        revisions.set(team, rev);
        if (before === rev && !reconnect) continue;
        for (const fn of [...listeners]) fn(team, rev, reconnect);
    }
}
export function onArtifactsRev(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Status also works through remote Hub proxies that do not forward the feed's
 * new field yet. Errors and missing tokens always fall back to reading data. */
export async function artifactsUnchanged(team, loaded, all = false) {
    if (artifactRevision(loaded) === null) return false;
    try {
        const r = await boardFetch(team, '/status', { cache: 'no-store' });
        if (!r.ok) return false;
        const rev = artifactRevision((await r.json())[all ? 'artifacts_all_rev' : 'artifacts_rev']);
        if (rev === null) return false;
        if (!all) {
            if (rev !== loaded) publishArtifactsRev({ [team]: rev });
            else if (!revisions.has(team)) revisions.set(team, rev);
        }
        return rev === loaded;
    } catch { return false; }
}

/** An explicit local save/send invalidates only its qualified team's lists, even
 * on an older server that has not returned an artifact revision yet. */
export function invalidateArtifacts(team, savedEdit = null) {
    if (!team) return;
    revisions.delete(team);
    for (const fn of [...listeners]) fn(team, null, true, savedEdit || true);
}
