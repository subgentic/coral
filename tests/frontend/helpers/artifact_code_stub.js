// A stubbed server for the artifact viewer's versions (#6480): three versions of release-plan.md, the version list, and the comments of the newest with a carried, an ambiguous and a gone one.
// Shared by artifact_versions_browser and the censuses' version scenes. STUB is page code to run with ev(): it replaces window.fetch.
const H1 = '1'.repeat(64), H2 = '2'.repeat(64), H3 = '3'.repeat(64);
const FILE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // the stubbed file's id (#14145): each version's row says its own line, as the server's list does
const lineOf = n => `version ${n} of release-plan.md (file ${FILE})`;
const T = {
    [H1]: ['# Release plan', '', 'Ship on Thursday.', 'The first step is the folder.', 'Terms stay as they are.'].join('\n'),
    [H2]: ['# Release plan', '', 'Ship the Servers page on Friday, with the team behind it.', 'The first step is the folder, then the details.', 'Revoke sits beside Rename on every row.', 'Terms stay as they are.'].join('\n'),
    [H3]: ['const STORAGE_KEY = "habit-tracker-state-v2";','function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { habits: [], days: {} }; } catch (e) { return { habits: [], days: {} }; } }','','document.querySelector("#add").addEventListener("click", () => { state.habits.push({ name: input.value, streak: 0 }); save(); render(); });'].join('\n'),
};

const STUB = `(() => {
    const real = window.fetch; window.__posts = []; const T = ${JSON.stringify(T)};
    const at = n => new Date(Date.now() - n * 3600000).toISOString();
    const rows = [['${H1}', 1, 30], ['${H2}', 2, 3], ['${H3}', 3, 1]].map(([d, v, h]) => ({ digest: d, version: v, versions: 3, is_latest: v === 3, name: 'app.js', file_id: '${FILE}', version_line: 'version ' + v + ' of release-plan.md (file ${FILE})', size: 9000 + v * 1500, media_type: 'text/javascript', at: at(h), uploader: 'frontend-dev', role: 'Frontend Dev' }));
    const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
    const who = n => (n === 'Operator' ? { kind: 'owner', issuer: 'local', subject: n, name: n } : { kind: 'agent', issuer: 'local', subject: n, name: n });
    const c = (id, art, ver, from, carried, quote, body, extra) => ({ id, artifact_id: art, parent_id: null, anchor: { quote }, body, author: who(extra && extra.by || 'Operator'), created_at: at(2), mine: true, can: { reply: true, edit: true, delete: true, resolve: true }, version: ver, ...(from ? { from_version: from, carried } : {}), ...(extra || {}) });
    window.fetch = (u, o) => {
        const url = String(u), method = (o && o.method) || 'GET';
        let m = /\\/api\\/artifacts\\/([0-9a-f]{64})\\/versions/.exec(url);
        if (m) return json(rows);
        m = /\\/api\\/artifacts\\/([0-9a-f]{64})\\/comments(\\/\\d+\\/\\w+)?(\\?.*)?$/.exec(url);
        if (m) {
            if (method === 'POST') { window.__posts.push(url); return json({ ...c(1, '${H2}', 2, 2, 'found', 'folder', 'Say what the folder is for.'), resolved_at: at(0) }); }
            const own = m[1];
            const list = own === '${H3}' && /series=1/.test(url) ? [
                c(10, '${H3}', 3, 0, '', 'Revoke moves into a More menu', 'Good, ship it.'),
                c(1, '${H2}', 2, 2, 'found', 'The first step is the folder', 'Say what the folder is for.', { by: 'Security Reviewer' }),
                c(2, '${H2}', 2, 2, 'ambiguous', 'the team behind it', 'Name who is on the team.', { by: 'QA Engineer' }),
                c(3, '${H1}', 1, 1, 'gone', 'Ship on Thursday.', 'Why Thursday?', { by: 'Frontend Dev' })] : [];
            return json({ comments: list, locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
        }
        m = /\\/api\\/artifacts\\/([0-9a-f]{64})(\\?v=\\d+)?$/.exec(url);
        if (m && T[m[1]]) return Promise.resolve(new Response(T[m[1]], { status: 200, headers: { 'Content-Type': 'text/javascript' } }));
        return real(u, o);
    };
    return true; })()`;

module.exports = { H1, H2, H3, T, STUB, FILE, lineOf };
