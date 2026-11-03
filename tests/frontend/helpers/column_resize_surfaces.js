// Actual production builders used by #12754's per-table resize contract checks.
const ROWS = [1, 2].map(n => ({ id: String(n).padStart(64, '0'), name: `report-${n}.md`, media_type: 'text/markdown', size: n * 1024, created_at: '2026-11-01T00:00:00Z', available: true, starred: true, board_id: 'team-a', team: 'Team A', uri: 'coral://artifacts/' + String(n).padStart(64, '0') }));
const SETUP = `const S = window.__coralStatic || '/static/'; const host = document.createElement('main'); host.id = 'resize-fixture'; host.style.cssText = 'width:940px;max-width:100%;margin:auto'; document.body.append(host); const real = window.fetch; const json = d => Promise.resolve(new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } }));`;
const CASES = {
    starred: `${SETUP}
        window.fetch = (u,o) => new URL(String(u),location.origin).pathname === '/api/team-artifacts' ? json({ artifacts: ${JSON.stringify(ROWS)}, total: 2, teams: [] }) : real(u,o);
        const m = await import(S + 'mailbox_starred_artifacts.js'); await new Promise(resolve => m.ensureStarredArtifacts(resolve)); document.body.replaceChildren(host); host.append(m.starredArtifactsSection());`,
};
module.exports = { CASES };
