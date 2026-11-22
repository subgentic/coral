// #20714: HTML, video and Markdown review rows share one computed tile palette.
// Real Inbox rows at 390/1280 in light/dark; retain existing glyphs and accessible labels.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const WANT = { 'Which hub': ['help_outline', 'Question'], 'Ship batch': ['help_outline', 'Question'], 'Plan 1': ['file-type', 'For review'], 'Fix the login': ['checklist', 'To approve'] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], T = '#group-table-view', team = 'nki-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const icon = needle => ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes(${JSON.stringify(needle)})); const i = tr && tr.querySelector('.inbox-kind-icon'); if (!i) return null; const cs = getComputedStyle(i), b = i.getBoundingClientRect();
        const svg=i.querySelector('.artifact-thumbnail > svg'); return { svg:svg?.outerHTML||'',svgHidden:svg?.getAttribute('aria-hidden'),glyph: getComputedStyle(i, '::before').content.replace(/"/g, ''), label: i.getAttribute('aria-label'), role: i.getAttribute('role'), text: i.textContent, font: cs.fontFamily, w: Math.round(b.width), color: cs.color, bg: cs.backgroundColor }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 820, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'W', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0'), made = n => new Date(Date.now() - n * 3600000).toISOString();
                const item = { id: hex(1), name: 'Plan 1 - review the release notes.html', media_type: 'text/html', size: 30, created_at: made(1), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(1), session_id: 'w-a', produced_by: 'Lead Developer' };
                const items = [item, {...item,id:hex(2),name:'Video review.mp4',media_type:'video/mp4',uri:'coral://artifacts/'+hex(2)}, {...item,id:hex(3),name:'Markdown review.md',media_type:'text/markdown',uri:'coral://artifacts/'+hex(3)}];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin), m = u.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts$/);
                    if (m && m[1] === '${team}') return json({ project: m[1], artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? items : [], has_more: false });
                    if (u.pathname === '/api/proposals') return json({ proposals: [{ id: 11, board_id: '${team}', kind: 'task', title: 'Fix the login page on Safari', proposer: 'Backend Dev', state: 'pending', created_at: new Date(Date.now() - 5400000).toISOString(), payload: { title: 'Fix the login page on Safari', body: 'It fails on Safari.' } }] });
                    if (u.pathname === '/api/operator-asks') return json([
                        { board: '${team}', board_label: 'Acme web', kind: 'ask', id: 41, asker: 'Orchestrator', text: '@Operator Which hub do we ship to: self-hosted or app.coralhub.dev?', at: new Date(Date.now() - 7 * 60000).toISOString() },
                        { board: '${team}', board_label: 'Acme web', kind: 'ask', id: 42, asker: 'Lead Developer', text: '@Operator Ship batch-120 tonight?', at: new Date(Date.now() - 9 * 60000).toISOString(), buttons: [{ id: 1, label: 'Yes', action: 'reply', state: 'pending' }, { id: 2, label: 'No', action: 'reply', state: 'pending' }] }]);
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`Object.keys(${JSON.stringify(WANT)}).every(n => [...document.querySelectorAll('${T} tbody tr')].some(r => r.textContent.includes(n)))`, at + 'the four rows', 15000);
            for (const theme of ['light', 'dark']) {
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await ev(framesJs(2));
                for (const [needle, [glyph, label]] of Object.entries(WANT)) {
                    const i = await icon(needle), what = `${at}${theme} ${needle}`;
                    check(!!i, what + ': the row has its icon');
                    if (!i) continue;
                    if (glyph === 'file-type') {
                        const expected=await ev(`import((window.__coralStatic||'/static/')+'file_icons.js').then(m=>m.fileIconHtml('Plan 1 - review the release notes.html','text/html'))`);
                        check(i.glyph === 'none' && i.svg === expected && i.svgHidden === 'true', `${what}: shared decorative HTML type icon replaces the generic review glyph: ${JSON.stringify(i)}`);
                    } else check(i.glyph === glyph, `${what}: the glyph is ${glyph}: ${JSON.stringify(i)}`);
                    check(i.label === label && i.role === 'img' && i.text === '', `${what}: named "${label}" for a screen reader, no text of its own: ${JSON.stringify(i)}`);
                    check((glyph === 'file-type' ? !!i.svg : /Material Icons/.test(i.font)) && i.w >= 24, `${what}: drawn by the icon font in its tile: ${JSON.stringify(i)}`);
                }
                const tiles = await ev(`['html','video','md'].map(type=>{const e=document.querySelector('${T} .inbox-kind-icon[data-kind="review"][data-type="'+type+'"]');if(!e)return null;const c=getComputedStyle(e);return {bg:c.backgroundColor,fg:c.color,border:c.borderColor};})`);
                check(tiles.every(Boolean) && tiles.every(t=>JSON.stringify(t)===JSON.stringify(tiles[0])), at+theme+': HTML, video and Markdown reviews share the same tile palette: '+JSON.stringify(tiles));
                const blue=await ev(`(()=>{const e=document.createElement('span');e.style.background='var(--needs-icon-blue-bg)';document.body.append(e);const c=getComputedStyle(e).backgroundColor;e.remove();return c;})()`);
                check(tiles[0]?.bg===blue,at+theme+': review tiles use the review blue, not the generic grey thumbnail wrapper');
                const symbols=await ev(`['html','video','md'].map(type=>{const icon=document.querySelector('${T} .inbox-kind-icon[data-kind="review"][data-type="'+type+'"]');return {ink:getComputedStyle(icon).color,strokes:[...icon.querySelectorAll('svg [stroke]:not([stroke="none"])')].map(p=>getComputedStyle(p).stroke),fills:[...icon.querySelectorAll('svg [fill]:not([fill="none"])')].map(p=>getComputedStyle(p).fill)};})`);
                check(symbols.every(s=>s.strokes.length&&s.strokes.every(c=>c===s.ink)&&s.fills.every(c=>c===s.ink)),at+theme+': SVG strokes and fills inherit the shared review ink: '+JSON.stringify(symbols));
                await ev(`document.querySelector('${T} .inbox-kind-icon[data-type="html"]').closest('tr').scrollIntoView({block:'start',behavior:'instant'});true`); await ev(framesJs(2));
                await shot(`needs-review-tiles-${w}-${theme}`);
            }
            await ev(`document.documentElement.removeAttribute('data-theme'); true`);
        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS review tile palette: HTML, video and Markdown match at 390/1280, light/dark; glyphs and labels retained');
})().catch(e => { console.error(e); process.exit(1); });
