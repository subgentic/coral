/* Whether a team's loaded artifacts are still current (one uncached status read answers every panel that asks in the same moment, #21126). Status also works through
 * remote Hub proxies that do not forward the feed's new field yet. Errors and missing tokens always fall back to reading data. */
import { boardFetch } from './server_base.js';
import { artifactRevision, publishArtifactsRev, revisions } from './artifacts_feed.js';
const reads = new Map();
const statusRead = team => reads.get(team) || reads.set(team, boardFetch(team, '/status', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).finally(() => reads.delete(team))).get(team);
export async function artifactsUnchanged(team, loaded, all = false) {
    if (artifactRevision(loaded) === null) return false;
    try {
        const rev = artifactRevision((await statusRead(team))?.[all ? 'artifacts_all_rev' : 'artifacts_rev']);
        if (!all) {
            if (rev !== loaded) { if (!revisions.has(team)) revisions.set(team, loaded); publishArtifactsRev({ [team]: rev }); } // a change found here is announced even when this is the first revision seen for the team
            else if (!revisions.has(team)) revisions.set(team, rev);
        }
        return rev === loaded;
    } catch { return false; }
}
