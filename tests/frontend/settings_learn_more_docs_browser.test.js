// Settings' Learn more links (#16349, Beta walk #16348): each one opens the user's own section for that setting in Docs, never the developer API reference. For every link Settings draws: its topic is in
// "Getting started" (not "For developers"), the heading it names is in that topic, and the link carries the answer it asks for; following one opens Docs at that heading. The docs sidebar lists Chief once.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.setItem('coral-sidebar-groups-docs', '[]'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import((window.__coralStatic || '/static/') + 'modals.js'); }).then(m => m.showSettingsModal('general')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#settings-modal a.sv-learn[href^="/docs/"]').length > 5`, 'the Learn more links are drawn', 12000);
        const links = await ev(`[...document.querySelectorAll('#settings-modal a.sv-learn[href^="/docs/"]')].map(a => ({ topic: decodeURIComponent(a.getAttribute('href').slice(6)), answer: a.dataset.answer || '', label: a.getAttribute('aria-label') }))`);
        assert.ok(links.length >= 9, `Settings has its Learn more links: ${links.length}`);
        await ev(`window.hideSettingsModal && window.hideSettingsModal(false); true`);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);
        const groups = await ev(`(() => { const out = []; let cur = null; for (const li of document.querySelectorAll('#docs-nav-list > li')) { const btn = li.querySelector('[data-doc]'); if (btn) { if (cur) cur.docs.push(btn.dataset.doc); } else { cur = { label: li.textContent.replace(/\\s+/g, ' ').trim(), docs: [] }; out.push(cur); } } return out; })()`);
        const start = new Set((groups.find(g => /^Getting started/.test(g.label)) || { docs: [] }).docs);
        const problems = [];
        for (const l of links) {
            if (!start.has(l.topic)) { problems.push(`${l.label}: /docs/${l.topic} is not in Getting started (it is for developers)`); continue; }
            if (!l.answer) { problems.push(`${l.label}: no answer named`); continue; }
            const doc = await ev(`fetch('/api/agent-docs/${encodeURIComponent(l.topic)}').then(r => r.json())`);
            const heads = String(doc.content || '').split('\n').filter(x => /^#{2,3} /.test(x)).map(x => x.replace(/^#+ /, '').trim());
            if (!heads.includes(l.answer)) problems.push(`${l.label}: "${l.answer}" is not a heading of ${l.topic}`);
        }
        assert.deepEqual(problems, [], '\n' + problems.join('\n'));
        const chief = await ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].filter(b => /^Chief\\b/.test(b.textContent.trim())).map(b => b.dataset.doc)`);
        assert.equal(chief.length, 1, `the docs sidebar lists Chief once: ${JSON.stringify(chief)}`);
        // following a link opens Docs at the setting's section
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); // a fresh page: Settings is followed from another page, as a person reaches it
        await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return true; })`);
        await ev(`window.showSettingsModal('general'); true`);
        await waitFor(`!!document.querySelector('#settings-modal[open]') || document.querySelector('#settings-modal')?.getClientRects().length > 0`, 'Settings is open');
        await waitFor(`[...document.querySelectorAll('#settings-modal a.sv-learn[href^="/docs/"]')].some(a => a.getClientRects().length > 0)`, 'a link is on screen');
        const pick = await ev(`(() => { const a = [...document.querySelectorAll('#settings-modal a.sv-learn[href^="/docs/"]')].filter(x => x.getClientRects().length > 0 && !x.getAttribute('href').endsWith('how-do-i')).pop(); a.id = 'pick-learn'; return { topic: decodeURIComponent(a.getAttribute('href').slice(6)), answer: a.dataset.answer }; })()`);
        await ev(`document.getElementById('pick-learn').click(); true`);
        await waitFor(`location.pathname === '/docs/${pick.topic}' && [...document.querySelectorAll('#docs-content h2, #docs-content h3')].some(h => h.textContent.trim() === ${JSON.stringify(pick.answer)})`, 'the section opens in Docs', 12000);
        await shot('settings-learn-more-docs-1280');
        console.log(`PASS ${links.length} Settings Learn more links open a Getting started section that has their heading; Chief is listed once`);
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
