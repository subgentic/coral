// A stand-in for GET /api/automations/runs (#13183) for a stubbed server: the same contract as the computer's (at most 50 a page, newest first, search and result before the cut, the true total, a cursor bound to the filters),
// built from the stub's own window.__jobRuns and window.__wfRuns. A workflow run a scheduled job started (trigger "scheduled" with the job run's id in its context) is left out, as the computer leaves it out.
// Put AUTO_RUNS_STUB in the page after the stub's own fetch is in place: it answers that route and passes every other read on.
exports.AUTO_RUNS_STUB = `(() => {
    const prev = window.fetch;
    const ms = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
    const resultOf = s => (s === 'running' ? 'running' : (s === 'failed' || s === 'killed') ? 'failed' : s === 'completed' ? 'passed' : '');
    window.__autoRunsAsked = [];
    window.__autoRunsPage = url => {
        const u = new URL(url, location.origin), q = (u.searchParams.get('q') || '').toLowerCase().trim(), result = u.searchParams.get('result') || '', cursor = u.searchParams.get('cursor') || '';
        const limit = Math.min(50, Number(u.searchParams.get('limit')) || 50);
        const all = [];
        for (const r of window.__jobRuns || []) all.push({ kind: 'job', id: r.id, at: ms(r.started_at || r.scheduled_at || r.created_at), name: String(r.display_name || r.job_name || 'job ' + r.job_id).toLowerCase(), status: r.status, run: r });
        for (const r of window.__wfRuns || []) {
            let sched = 0; try { sched = Number(JSON.parse(r.trigger_context || '{}').scheduled_run_id) || 0; } catch (e) { sched = 0; }
            if (r.trigger_type === 'scheduled' && sched) continue;
            all.push({ kind: 'workflow', id: r.id, at: ms(r.started_at || r.created_at), name: String(r.workflow_name || '').toLowerCase(), status: r.status, run: r });
        }
        const fkey = JSON.stringify([q, result]);
        const rows = all.filter(x => (!q || x.name.includes(q) || x.status.includes(q) || resultOf(x.status).includes(q)) && (!result || resultOf(x.status) === result))
            .sort((a, b) => b.at - a.at || b.id - a.id || (a.kind < b.kind ? 1 : -1));
        let start = 0;
        if (cursor) {
            let c = null; try { c = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { c = null; }
            if (!c || c.f !== fkey) return { status: 400, body: { error: 'cursor is for other filters' } };
            start = rows.findIndex(x => x.at === c.a && x.id === c.i && x.kind === c.k) + 1;
        }
        const slice = rows.slice(start, start + limit), more = start + limit < rows.length, last = slice[slice.length - 1];
        const next = more && last ? btoa(JSON.stringify({ a: last.at, i: last.id, k: last.kind, f: fkey })).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') : '';
        return { status: 200, body: { runs: slice.map(x => ({ kind: x.kind, ...x.run })), has_more: more, next_cursor: next, total: rows.length } };
    };
    window.fetch = (u, o) => {
        const url = String(u), method = (o && o.method) || 'GET';
        if (method === 'GET' && /\\/api\\/automations\\/runs(\\?|$)/.test(url)) {
            window.__autoRunsAsked.push(url);
            const a = window.__autoRunsPage(url);
            return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } }));
        }
        return prev(u, o);
    };
})()`;
