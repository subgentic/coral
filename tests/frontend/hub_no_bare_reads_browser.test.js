// #14766 (the audit after #14743): through the Hub with no computer shown, the dashboard asks the Hub's own origin only for what the Hub serves (its account, its computers, its sessions list...). A read of a COMPUTER's route (chief, tags, custom views, pinned folders...) at the bare path is the Hub's own and answers 404: one in
// every page's console. This census records every request of /api/ at the bare path on Goals, Agents and Inbox with nothing selected, and expects only the Hub's own routes; anything else is a bare read that should have been skipped or sent through /api/remote/<computer>/.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { setupHubWorld } = require('./helpers/hub_world');
// What the Hub itself serves at its own origin (the stub Hub world answers these too).
const HUB_OWN = [/^\/api\/account$/, /^\/api\/servers(\/|$)/, /^\/api\/sessions\/live$/, /^\/api\/settings$/, /^\/api\/health$/, /^\/api\/needs-you$/, /^\/api\/system\/cli-check$/, /^\/api\/token-usage$/, /^\/api\/remote\//, /^\/api\/cloud-unavailable$/, /^\/api\/auth\//, /^\/api\/me$/];
// None allowed: the four stubs the Hub answered (system/status, update-check, scheduled/jobs, tracking/event) are skipped in Hub mode (#14820), so a bare read of any of them fails this census.
const ASK_HUB = [];
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { window.__bareReqs = []; const f = window.fetch.bind(window); window.fetch = (u, o) => { try { const p = new URL(String(u && u.url || u), location.href); if (p.origin === location.origin && p.pathname.startsWith('/api/')) window.__bareReqs.push(p.pathname); } catch { /* not a URL */ } return f(u, o); }; })();` });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            for (const tab of ['agents', 'hub-inbox', 'servers']) { await ev(`window.switchNavTab && window.switchNavTab(${JSON.stringify(tab)}); true`); await new Promise(r => setTimeout(r, 900)); } // sleep-ok: each page paints and asks what it asks
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).catch(() => {}).then(() => true)`); await new Promise(r => setTimeout(r, 900)); // sleep-ok: Goals paints
            const all = await ev(`window.__bareReqs`);
            const counts = {}; for (const p of all) counts[p] = (counts[p] || 0) + 1;
            console.log(`${at}bare /api requests: ` + JSON.stringify(counts));
            const stray = Object.keys(counts).filter(p => !HUB_OWN.some(re => re.test(p)) && !ASK_HUB.some(re => re.test(p)));
            check(`${at}no bare read: only the Hub's own routes are asked at its origin`, stray.length === 0, JSON.stringify(stray));
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
