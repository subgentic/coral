// #16015, the Operator's ask: the $ menu also lists the skills in the person's own folders and in the agent's working folder, each row saying where it comes from (Coral / You / This repo). A pick of one of the
// person's or the repo's skills puts "Use the skill <name>." in the message and attaches nothing (no attach call: Coral's store holds none of it); a pick of Coral's skill attaches as before. The menu is asked
// with the agent's session_id (the repo's skills are read from that agent's folder only). The two routes are stood in in the page. 1280 and 390, light and dark.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SKILLS = [
    { id: 'c'.repeat(32), name: 'release-notes', version: 1, description: 'Write the release notes', source: 'coral' },
    { id: '', name: 'my-review', version: 0, description: 'My own review checklist.', source: 'you' },
    { id: '', name: 'repo-deploy', version: 0, description: 'Deploys this repo.', source: 'repo' },
];
const STUB = `(() => { window.__menuAsks = []; window.__skillAttach = []; const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (u, o) => { const url = new URL(String(u), location.href);
        if (url.pathname === '/api/skills/search') { window.__menuAsks.push(url.search); const q = (url.searchParams.get('q') || '').toLowerCase(); return json({ skills: ${JSON.stringify(SKILLS)}.filter(s => !q || (s.name + ' ' + s.description).toLowerCase().includes(q)) }); }
        if (/\\/api\\/sessions\\/live\\/[^/]+\\/skills$/.test(url.pathname) && o && o.method === 'POST') { const b = JSON.parse(o.body); window.__skillAttach.push(b.skill_id); return json({ ok: true, attached: true, line: 'Use the skill release-notes (coral-agent skills get --id ' + b.skill_id + ').' }); }
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const type = async text => { await ev(`document.getElementById('command-input').focus(); true`); await Input.insertText({ text }); };
    const clear = async () => { await ev(`(() => { const i = document.getElementById('command-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); };
    const key = async k => { const code = { ArrowDown: 40, Enter: 13 }[k]; await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); };
    const rows = () => ev(`(() => { const d = document.querySelector('.skill-mention-dropdown'); if (!d || getComputedStyle(d).display === 'none') return null; return [...d.querySelectorAll('.skill-mention-item')].map(n => ({ name: (n.querySelector('.skill-name') || {}).textContent, source: (n.querySelector('.skill-source') || {}).textContent || '', w: Math.round(n.getBoundingClientRect().width), sw: n.scrollWidth })); })()`);
    const shown = n => `(() => { const d = document.querySelector('.skill-mention-dropdown'); return !!d && getComputedStyle(d).display !== 'none' && d.querySelectorAll('.skill-mention-item').length === ${n}; })()`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            for (const theme of ['light', 'dark']) {
                const tag = `${w} px ${theme}`;
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
                await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('sk-a', 'A', 3, { sleeping: false, session_id: 'sk-a-id' }); window.selectLiveSession('sk-a', 'claude', 'sk-a-id', 'local'); true`);
                await waitFor(`!!document.getElementById('command-input') && !document.getElementById('command-input').disabled`, `${tag}: the composer`, 8000);
                await clear(); await ev(`window.__menuAsks.length = 0; window.__skillAttach.length = 0; true`);

                await type('$');
                await waitFor(shown(3), `${tag}: the three skills`, 4000);
                let r = await rows();
                check(`${tag}: each row says where it comes from`, JSON.stringify(r.map(x => [x.name, x.source])) === JSON.stringify([['release-notes', 'Coral'], ['my-review', 'You'], ['repo-deploy', 'This repo']]), JSON.stringify(r));
                check(`${tag}: no row is wider than the menu (the label fits)`, r.every(x => x.sw <= x.w + 1), JSON.stringify(r));
                const asks = await ev(`window.__menuAsks`);
                check(`${tag}: the menu is asked with this agent's session_id`, asks.length >= 1 && asks.every(a => a.includes('session_id=sk-a-id')), JSON.stringify(asks));
                await shot(`skills-sources-${w}-${theme}`);

                // the repo's skill: the message names it, nothing is attached
                await key('ArrowDown'); await key('ArrowDown');
                await waitFor(`document.querySelectorAll('.skill-mention-item')[2].classList.contains('selected')`, `${tag}: ArrowDown twice`, 3000);
                await key('Enter');
                await waitFor(`/Use the skill repo-deploy\\./.test(document.getElementById('command-input').value)`, `${tag}: the repo skill's line`, 4000);
                check(`${tag}: "$" is replaced by the plain line and a space`, (await ev(`document.getElementById('command-input').value`)) === 'Use the skill repo-deploy. ', await ev(`document.getElementById('command-input').value`));
                check(`${tag}: nothing was attached for the repo's skill`, (await ev(`window.__skillAttach.length`)) === 0);

                // Coral's own skill still attaches
                await clear(); await type('$rel');
                await waitFor(shown(1), `${tag}: $rel`, 4000);
                await key('Enter');
                await waitFor(`/Use the skill release-notes \\(coral-agent skills get/.test(document.getElementById('command-input').value)`, `${tag}: Coral's line`, 4000);
                check(`${tag}: Coral's skill was attached once`, JSON.stringify(await ev(`window.__skillAttach`)) === JSON.stringify(['c'.repeat(32)]));
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the $ menu sources:\n  ' + problems.join('\n  '));
    console.log('PASS the $ menu: Coral / You / This repo labels, a local pick attaches nothing, Coral attaches, 1280 and 390, light and dark');
})().catch(e => { console.error(e); process.exit(1); });
