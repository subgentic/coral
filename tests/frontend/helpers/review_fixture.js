// Legacy UI fixtures describe board-artifact rows. Let their predicates match
// the same review rows now read through the owner-only cross-team endpoint.
// This changes only the URL object used by an opted-in fixture's predicates;
// it never redirects fetch. A fixture's passthrough retains the ORIGINAL URL.
// Routing/authorization tests should use the original URL and must not opt in.
function reviewFixtureURL(input, base) {
    const url = new URL(input, base);
    const match = /^(\/api\/remote\/[^/]+)?\/api\/team-artifacts$/.exec(url.pathname);
    if (match && url.searchParams.get('starred_first') === 'true' && url.searchParams.get('tag') === 'for review' && url.searchParams.has('team')) {
        if (url.searchParams.get('team') !== '~no-team') url.pathname = (match[1] || '') + '/api/board/' + encodeURIComponent(url.searchParams.get('team')) + '/artifacts';
        url.searchParams.delete('team'); url.searchParams.delete('starred_first');
    }
    return url;
}
module.exports = { reviewFixtureURL };

/** The stored identifier, for fixtures whose older rows used a display id. */
function reviewFixtureDigest(row) {
    const hex = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i.exec(row.uri || row.digest || row.id || '')?.[1];
    if (!hex) throw new Error('A review fixture row needs a stored digest.');
    return hex.toLowerCase();
}

/** Pure owner-list fixture: no fetches, URL rewriting or authorization fallback.
 * Call with the ORIGINAL request URL before a legacy predicate adapter:
 *   const page = __reviewFixturePage(input, location.href, { [boardId]: rows });
 *   if (page) return json(page);
 * A board value may be { team: displayLabel, artifacts: rows }. The dictionary
 * keys are raw board ids, not labels or qualified computer/team keys. Supply
 * only this request's computer's already-authorized fixture rows. Explicit
 * refusal/routing tests should use their original URLs and responses instead.
 * The helper pages a COMPLETE fixture collection. Do not pass an already cut
 * page; cursor/failure tests can intercept their failing request before it.
 */
function reviewFixturePage(input, base, boards, options = {}) {
    const url = new URL(String(input), base);
    if (!/^(\/api\/remote\/[^/]+)?\/api\/team-artifacts$/.test(url.pathname)) return null;
    const params = url.searchParams, all = [], refs = [];
    for (const [board, value] of Object.entries(boards)) {
        if (!board || board.startsWith('@') || board.includes('/')) throw new Error('Review fixtures need raw board ids.');
        const list = Array.isArray(value) ? value : value.artifacts;
        const label = Array.isArray(value) ? board : value.team || board;
        if (!Array.isArray(list)) throw new Error('A review fixture board needs an artifact array.');
        refs.push({ board_id: board, team: label, all: list.length });
        for (const row of list) {
            if (row.board_id && row.board_id !== board) throw new Error('A fixture row belongs to another board.');
            const id = reviewFixtureDigest(row);
            all.push({ ...row, id, board_id: board, team: label });
        }
    }
    const values = key => params.getAll(key).flatMap(v => v.split(',')).filter(Boolean);
    const teams = values('team'), tags = values('tag'), digests = values('digest').map(v => v.toLowerCase());
    if (digests.length > 20 || digests.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid fixture digest filter.');
    const newVersion = row => Number.isSafeInteger(row.version) && Number.isSafeInteger(row.opened_version) && row.opened_version > 0 && row.opened_version < row.version;
    const read = row => row.tags?.includes('read') && !(row.new_comments > 0) && !newVersion(row);
    const waiting = row => {
        const t = row.tags || [], news = row.new_comments > 0;
        if (!row.available || ['saved', 'ignored', 'superseded'].some(tag => t.includes(tag))) return false;
        return t.includes('for review') ? news || (!t.includes('changes requested') && !read(row)) : news && (t.includes('approved') || t.includes('denied'));
    };
    const groupKey = row => JSON.stringify([row.board_id, row.series_id || ((row.session_id || row.produced_by) ? [row.session_id, row.produced_by, row.name] : row.id)]);
    const newest = (a, b) => (Number(a.version) || 0) - (Number(b.version) || 0) || String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id);
    const allGroups = new Map();
    for (const row of all) { const key = groupKey(row); if (!allGroups.has(key)) allGroups.set(key, []); allGroups.get(key).push(row); }
    const matches = (row, omit = '') => {
        const t = row.tags || [], news = row.new_comments > 0;
        if (omit !== 'team' && teams.length && !teams.some(team => team === row.board_id || team === row.team)) return false;
        if (tags.length && !tags.some(tag => t.includes(tag) || tag === 'new comments' && news || tag === 'for review' && news && (t.includes('approved') || t.includes('denied')))) return false;
        if (digests.length && !digests.includes(row.id)) return false;
        if (params.get('muted') === '0' && row.muted || params.get('muted') === '1' && !row.muted) return false;
        if (params.has('waiting') && waiting(row) !== (params.get('waiting') === '1')) return false;
        if (params.has('read') && !!read(row) !== (params.get('read') === '1')) return false;
        if (omit !== 'by' && params.get('by') && String(row.produced_by || row.sent_by || '').toLowerCase() !== params.get('by').toLowerCase()) return false;
        if (omit !== 'goal' && params.get('goal') && Number(row.goal_id) !== Number(params.get('goal'))) return false;
        if (params.get('until') && Date.parse(row.review_sent_at || row.created_at) > Date.parse(params.get('until'))) return false;
        if (params.get('since') && Date.parse(row.created_at) < Date.parse(params.get('since'))) return false;
        if (params.get('q') && ![row.name, row.review_question, row.produced_by, row.goal_title, row.task_title].filter(Boolean).join(' ').toLowerCase().includes(params.get('q').toLowerCase())) return false;
        return true;
    };
    const select = omit => {
        let rows = all.filter(row => matches(row, omit));
        if (params.get('versions') === 'newest' || params.get('starred_first') === 'true') {
            const groups = new Map();
            for (const row of rows) { const key = groupKey(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
            rows = [];
            for (const group of groups.values()) {
                const top = group.reduce((a, b) => newest(a, b) >= 0 ? a : b);
                const collapse = params.get('versions') === 'newest' || group.some(row => row.starred);
                if (!collapse) { rows.push(...group); continue; }
                const older = allGroups.get(groupKey(top)).filter(row => newest(row, top) < 0);
                rows.push({ ...top, starred: group.some(row => row.starred), ...(older.length ? { version: top.version || older.length + 1, earlier_digests: top.earlier_digests || older.slice(0, 50).map(row => row.id) } : {}) });
            }
        }
        return rows;
    };
    const selected = select('');
    const sign = params.get('sort') === 'oldest' ? 1 : -1;
    selected.sort((a, b) => (params.get('starred_first') === 'true' ? Number(!!b.starred) - Number(!!a.starred) : 0) || sign * String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id));
    const fingerprint = url.pathname + '?' + [...params].filter(([k]) => k !== 'cursor' && k !== 'offset').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    let start = Number(params.get('offset') || 0);
    if (params.get('cursor')) {
        let cursor;
        try { cursor = JSON.parse(decodeURIComponent(params.get('cursor'))); } catch { throw new Error('Invalid review fixture cursor.'); }
        if (cursor.query !== fingerprint) throw new Error('A fixture cursor belongs to another computer or query.');
        start = cursor.at;
    }
    const limit = Math.min(50, Number(params.get('limit') || 50));
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid review fixture page.');
    const artifacts = selected.slice(start, start + limit), more = start + artifacts.length < selected.length;
    const counts = Object.create(null);
    for (const row of selected) for (const tag of new Set(row.tags || [])) counts[tag] = (counts[tag] || 0) + 1;
    const facets = Object.create(null);
    for (const kind of values('facets')) {
        if (!['team', 'by', 'goal'].includes(kind)) throw new Error('Unknown review fixture facet.');
        const valuesOf = new Map();
        for (const row of select(kind)) {
            const v = kind === 'team' ? row.team : kind === 'by' ? row.produced_by || row.sent_by : row.goal_title;
            const id = kind === 'goal' ? Number(row.goal_id) : 0;
            if (!v || kind === 'goal' && !id) continue;
            const key = `${id}:${v}`;
            if (!valuesOf.has(key)) valuesOf.set(key, { v, n: 0, ...(id ? { id } : {}) });
            valuesOf.get(key).n++;
        }
        facets[kind] = [...valuesOf.values()].sort((a, b) => b.n - a.n || a.v.localeCompare(b.v) || (a.id || 0) - (b.id || 0)).slice(0, 100);
    }
    return { artifacts, total: selected.length, all: all.length, teams: refs, tag_counts: counts, limit, offset: start, has_more: more,
        ...(more ? { next_cursor: encodeURIComponent(JSON.stringify({ at: start + artifacts.length, query: fingerprint })) } : {}),
        ...(params.has('facets') ? { facets } : {}), ...(options.truncated ? { truncated: true } : {}) };
}
module.exports.reviewFixtureDigest = reviewFixtureDigest;
module.exports.reviewFixturePage = reviewFixturePage;
