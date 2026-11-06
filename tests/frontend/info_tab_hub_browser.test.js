// The Info tab through a Coral Hub (#13917; UI Reviewer asked for a real remote computer and the real selection path, not a stub): the page is served as the Hub's (helpers/hub_world.js: cloud mode, two computers m1 and m2, their
// agents), the agent's fields are read from the info route of ITS computer (/api/remote/<id>/...), the three sections (the Operator's routes, this computer's own agents only) are never asked for, and picking another agent on
// another computer with Info open drops the first one's fields at once and reads the second's; a held answer of the first, released after the pick, writes nothing under the second.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const prev = window.fetch; window.__infoReqs = []; window.__sectionReqs = []; window.__held = {};
            window.fetch = (u, o) => { const p = new URL(String(u), location.href);
                const m = p.pathname.match(/^\\/api\\/remote\\/([^/]+)\\/api\\/sessions\\/live\\/([^/]+)\\/(info|mcp-servers|loaded-skills|memory)/), l = p.pathname.match(/^\\/api\\/sessions\\/live\\/([^/]+)\\/(info|mcp-servers|loaded-skills|memory)/);
                if (m && m[3] !== 'info') window.__sectionReqs.push(p.pathname); if (l && l[2] !== 'info') window.__sectionReqs.push(p.pathname);
                if (m && m[3] === 'info') { const server = m[1], name = decodeURIComponent(m[2]); window.__infoReqs.push(p.pathname + p.search);
                    const body = { agent_name: name + ' on ' + server, agent_type: 'claude', tmux_command: 'tmux attach -t ' + server, working_directory: '/work/' + server, prompt: 'prompt from ' + server, board_name: 'team-' + server, board_label: 'Board ' + server };
                    return (window.__held[server] || Promise.resolve()).then(() => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })); }
                return prev(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`!!window.__coralReady`, 'dashboard ready'); await coralReady(ev, 'startup', 'settings');
        assert.equal(await ev(`JSON.parse(document.getElementById('coral-boot').textContent).mode`), 'cloud', 'the page is the Hub\'s');
        const text = id => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
        const turns = () => ev(`new Promise(r => setTimeout(() => setTimeout(() => r(true), 0), 0))`);
        await waitFor(`!!window.selectLiveSession`, 'the page\'s live view');
        await waitFor(`!!window.__computers`, 'the stubbed Hub');

        console.log('An agent on computer m1: its fields come from m1\'s info route; no section is asked for');
        await ev(`window.selectLiveSession('hub-agent-0', 'claude', 'hub-agent-0', 'm1'); window.switchAgenticTab('info', 'top'); true`);
        await waitFor(`document.getElementById('info-agent-name').textContent === 'hub-agent-0 on m1'`, 'm1\'s fields');
        assert.match(await ev(`window.__infoReqs[0]`), /^\/api\/remote\/m1\/api\/sessions\/live\/hub-agent-0\/info\?/, 'the info read goes through the Hub to the agent\'s own computer');
        assert.equal(await text('info-prompt'), 'prompt from m1'); assert.equal(await text('info-working-dir'), '/work/m1');
        await turns();
        assert.deepEqual(await ev(`window.__sectionReqs`), [], 'the MCP, skills and memory routes are never asked for a remote computer\'s agent');
        assert.equal(await ev(`['info-mcp', 'info-skills', 'info-memory'].every(id => document.getElementById(id).hidden)`), true, 'no section shows');

        console.log('Picking an agent on computer m2 with Info open: m1\'s fields are gone at once, m2\'s come in; a held m1 answer released later writes nothing');
        await ev(`window.__held.m1 = new Promise(r => { window.__releaseM1 = r; }); window.selectLiveSession('hub-agent-1', 'claude', 'hub-agent-1', 'm1'); true`); // the next m1 agent: its answer is held
        await waitFor(`document.getElementById('info-agent-name').textContent === '' && document.getElementById('info-tab-grid').hidden`, 'm1\'s first agent dropped at the pick, while the next read is pending');
        await ev(`window.selectLiveSession('hub-agent-2', 'claude', 'hub-agent-2', 'm2'); true`);
        await waitFor(`document.getElementById('info-agent-name').textContent === 'hub-agent-2 on m2'`, 'm2\'s fields');
        assert.ok((await ev(`window.__infoReqs`)).some(u => /^\/api\/remote\/m2\/api\/sessions\/live\/hub-agent-2\/info\?/.test(u)), 'm2\'s agent is read from m2');
        await ev(`window.__releaseM1(); true`); await turns();
        assert.equal(await text('info-agent-name'), 'hub-agent-2 on m2', 'the held answer of the agent on m1 does not land under the one on m2');
        assert.equal(await text('info-prompt'), 'prompt from m2'); assert.equal(await ev(`document.querySelector('#info-board a').textContent`), 'Board m2');
        assert.deepEqual(await ev(`window.__sectionReqs`), [], 'still no section request');
        console.log('PASS info tab through a hub');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
