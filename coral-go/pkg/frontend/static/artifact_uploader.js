/* Who uploaded the version being viewed, by the role the board knows them by (#13995): the Send to agent picker starts with that agent ticked. The only sources are the opener's own record, passed through the viewer as
 * { role, server, board, hex, seriesId }: (1) the role it captured, for the exact computer, team and version it was captured for; (2) for ANOTHER version of the same series (the viewer moved on, or the thread is on an older one), the
 * series route with the series_id the row held, GET /api/artifacts/series/<id>/versions, whose rows name each version's role. Nothing is searched for: not the team's artifact list, and never the digest-only
 * GET /api/artifacts/<hex>/versions (it answers the FIRST series that holds the bytes, across teams, so two teams sharing a file could name the other team's uploader). No record: '' and nobody is ticked, as before. */
import { serverUrl, normServer } from './server_base.js';

/** The role of the agent that uploaded the version `hex` on `server` of `board`, from the record the opener captured, or ''. */
export async function uploaderOf({ hex, server, board }, captured) {
    const want = String(hex || '').toLowerCase();
    if (!want || !captured || typeof captured !== 'object') return '';
    if (normServer(captured.server) !== normServer(server) || String(captured.board || '') !== String(board || '')) return ''; // another computer or team: never this one's
    if (String(captured.hex || '').toLowerCase() === want) return typeof captured.role === 'string' ? captured.role.trim() : '';
    if (!/^[0-9a-f]{32}$/.test(String(captured.seriesId || ''))) return '';
    try {
        const r = await fetch(serverUrl(`/api/artifacts/series/${captured.seriesId}/versions`, server));
        if (!r.ok) return '';
        const row = ((await r.json()) || []).find(v => String(v.digest || '').toLowerCase() === want);
        return row && typeof row.role === 'string' ? row.role.trim() : '';
    } catch { return ''; }
}
