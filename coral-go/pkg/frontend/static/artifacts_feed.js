/* Artifact revisions are freshness hints. Missing fields on older servers keep
 * the existing timed reads; only an explicit matching token can skip a list. */
import { importOnce } from './import_once.js';
export const revisions = new Map(), listeners = new Set();
let readEpoch = 0;
export const artifactReadEpoch = () => readEpoch;
export const invalidateArtifactReads = () => { readEpoch++; };
export const artifactRevision = value => Number.isSafeInteger(value) && value > 0 ? value : null;
let seeded; // the page's first full update is its first sight of the revisions, not a return after a gap: lists read a moment before it are current (#21126)
export function publishArtifactsRev(brief, reconnect = false) {
    const first = reconnect && !seeded;
    seeded = seeded || reconnect;
    reconnect = reconnect && !first;
    if (reconnect) { readEpoch++; for (const fn of [...listeners]) fn(null, null, true); }
    for (const [team, raw] of Object.entries(brief || {})) { // a string or a number has no team keys: nothing to read
        const rev = artifactRevision(raw);
        if (rev === null) continue;
        const before = revisions.get(team);
        revisions.set(team, rev);
        if (!reconnect && (before === rev || before === undefined)) continue; // a revision seen for the first time has nothing to compare: lists read before it carry their own token, checked at the next pass (#21126)
        readEpoch++;
        for (const fn of [...listeners]) fn(team, rev, reconnect);
    }
}
export function onArtifactsRev(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Whether a team's loaded artifacts are still current: read lazily, it is only asked after a list was read (artifacts_unchanged.js). */
export const artifactsUnchanged = (...args) => importOnce('./artifacts_unchanged.js').then(m => m.artifactsUnchanged(...args), () => false);
/** An explicit local save/send invalidates only its qualified team's lists, even
 * on an older server that has not returned an artifact revision yet. */
export function invalidateArtifacts(team, savedEdit = null) {
    if (!team) return;
    readEpoch++;
    revisions.delete(team);
    for (const fn of [...listeners]) fn(team, null, true, savedEdit || true);
}
