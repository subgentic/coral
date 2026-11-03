const { ROWS, SETUP } = require('../resize_case_setup');
module.exports = `${SETUP}
        window.fetch = (u,o) => new URL(String(u),location.origin).pathname === '/api/team-artifacts' ? json({ artifacts: ${JSON.stringify(ROWS)}, total: 2, teams: [] }) : real(u,o);
        const m = await import(S + 'mailbox_starred_artifacts.js'); await new Promise(resolve => m.ensureStarredArtifacts(resolve)); document.body.replaceChildren(host); host.append(m.starredArtifactsSection());`;
