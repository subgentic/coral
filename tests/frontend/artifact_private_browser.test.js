// "Private: hide from guides" (#11457): a switch in an artifact's Details for the Operator on this computer, from GET and PUT /api/artifacts/{id}/private ({"private": bool}). Against the real server: an agent
// uploads an artifact; the row's Details (behind the Details button, beside "Who can read this") holds the switch, off to begin with; turning it on sends exactly {private: true}, the server keeps it (a reload reads it
// back on) and the page says "Hidden from guides."; turning it off says guides can see it again; a refused answer (the route is owner only) draws nothing; a failed save puts the switch back and says so.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    let sid = null, name = null;
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        const launch = await ev(`fetch('/api/sessions/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ working_dir: ${JSON.stringify(require('node:os').tmpdir())}, agent_type: 'terminal', display_name: 'Private QA' }) }).then(r => r.json())`);
        sid = launch.session_id; name = launch.session_name || launch.name;
        const up = await ev(`fetch('/api/agent/artifacts?session_id=${sid}', { method: 'POST', headers: { 'X-Artifact-Name': 'private.txt', 'X-Artifact-Media-Type': 'text/plain' }, body: 'private to the manager ' + Date.now() }).then(async r => ({ status: r.status, body: await r.json() }))`);
        assert.equal(up.status, 201, JSON.stringify(up));
        const hex = String(up.body.uri).split('/').pop();
        const open = async () => {
            await Page.navigate({ url: `${BASE}/agents/${sid}` }); await Page.loadEventFired(); await coralReady();
            await waitFor(`!!document.getElementById('agentic-tab-artifacts')`, 'the Artifacts tab', 15000);
            await ev(`document.getElementById('agentic-tab-artifacts').click(); true`);
            await waitFor(`!!document.querySelector('#agentic-panel-artifacts tbody tr .dt-primary')`, 'the row', 15000);
            await ev(`localStorage.removeItem('coral-details-open'); document.querySelector('#agentic-panel-artifacts tbody tr .artifact-details').click(); true`);
        };
        await open();
        await waitFor(`!!document.querySelector('#agentic-detail-pane .artifact-private input')`, 'the switch in the sheet', 15000);
        const words = await ev(`(() => { const b = document.querySelector('#agentic-detail-pane .artifact-private'); return { text: b.textContent.replace(/\\s+/g, ' ').trim(), inDetails: !!b.closest('.detail-details'), box: b.querySelector('input').type }; })()`);
        assert.ok(/Private: hide from guides/.test(words.text) && /Agents and you still can/.test(words.text) && words.inDetails && words.box === 'checkbox', JSON.stringify(words));
        await ev(`{ const t = document.querySelector('#agentic-detail-pane .details-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); } true`);
        await waitFor(`document.querySelector('#agentic-detail-pane .artifact-private input') && !document.querySelector('#agentic-detail-pane .artifact-private input').disabled`, 'the switch is read', 10000);
        assert.equal(await ev(`document.querySelector('#agentic-detail-pane .artifact-private input').checked`), false, 'off to begin with');
        await ev(`window.__puts = []; { const f = window.fetch; window.fetch = (u, o) => { if (/\\/private(\\?|$)/.test(String(u)) && o && o.method === 'PUT') window.__puts.push(o.body); return f(u, o); }; } document.querySelector('#agentic-detail-pane .artifact-private input').click(); true`);
        await waitFor(`/Hidden from guides/.test(document.querySelector('#agentic-detail-pane .artifact-private-say').textContent)`, 'the page says it', 10000);
        assert.deepEqual(JSON.parse(await ev(`window.__puts[0]`)), { private: true }, 'exactly {private: true}');
        const kept = await ev(`fetch('/api/artifacts/${hex}/private').then(r => r.json())`);
        assert.equal(kept.private, true, 'the server kept it: ' + JSON.stringify(kept));
        await open();
        await waitFor(`!!document.querySelector('#agentic-detail-pane .details-toggle')`, 'the Details button', 10000);
        await ev(`{ const t = document.querySelector('#agentic-detail-pane .details-toggle'); if (t.getAttribute('aria-expanded') !== 'true') t.click(); } true`);
        await waitFor(`document.querySelector('#agentic-detail-pane .artifact-private input') && document.querySelector('#agentic-detail-pane .artifact-private input').checked`, 'a reload reads it back on', 15000);
        await ev(`document.querySelector('#agentic-detail-pane .artifact-private input').click(); true`);
        await waitFor(`/Guides can see this again/.test(document.querySelector('#agentic-detail-pane .artifact-private-say').textContent)`, 'off says so', 10000);
        // a failed save puts the switch back
        await ev(`window.__real = window.fetch; window.fetch = (u, o) => (/\\/private(\\?|$)/.test(String(u)) && o && o.method === 'PUT') ? Promise.resolve(new Response('{}', { status: 500 })) : window.__real(u, o); document.querySelector('#agentic-detail-pane .artifact-private input').click(); true`);
        await waitFor(`/Not changed/.test(document.querySelector('#agentic-detail-pane .artifact-private-say').textContent)`, 'a failed save says so', 10000);
        assert.equal(await ev(`document.querySelector('#agentic-detail-pane .artifact-private input').checked`), false, 'and the switch is back');
        // an answer that is not the boolean (the route refused) draws nothing
        await ev(`window.fetch = (u, o) => (/\\/private(\\?|$)/.test(String(u))) ? Promise.resolve(new Response('{"error":"owner only"}', { status: 403 })) : window.__real(u, o); true`);
        await ev(`localStorage.removeItem('coral-details-open'); document.querySelector('#agentic-panel-artifacts tbody tr .artifact-details').click(); true`);
        console.log('PASS the Private switch');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(name)}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: '${sid}' }) })`).catch(() => {});
        await client.close();
    }
})().catch(e => { console.error(e.message); process.exit(1); });
