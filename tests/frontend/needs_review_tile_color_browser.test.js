// #20714: HTML, video and Markdown review rows share one computed tile palette.
// Real Inbox rows at 390/1280 in light/dark; retain existing glyphs and accessible labels.
// On the ledger (#22094): a question's icon is waving_hand named "Question", a file's is an icon-font glyph by type (code for HTML, description for Markdown and video) named "File for review", drawn from the font's ligature (role img, so a screen reader hears only the name); a proposal keeps the shared kind icon (checklist, "To approve"). HTML, video and Markdown file icons still share one computed palette, with 4.5:1 against the row in light and dark.
// Retired on the ledger (#22094): the decorative SVG file-type picture (#20714) and the blue file tile (#21161): the approved mock draws a file's type as a plain glyph in the icon column (covered by needs_ledger and needs_kind_icons), so there is no tile background or SVG stroke to compare.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const WANT = { 'Which hub': ['waving_hand', 'Question'], 'Ship batch': ['waving_hand', 'Question'], 'Plan 1': ['code', 'File for review'], 'Video review': ['description', 'File for review'], 'Markdown review': ['description', 'File for review'], 'Fix the login': ['checklist', 'To approve'] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], T = '#group-table-view', team = 'nki-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const icon = needle => ev(`(() => { const tr = [...document.querySelectorAll('${T} .nl-row')].find(r => r.textContent.includes(${JSON.stringify(needle)})); const i = tr && tr.querySelector(':scope > .nl-icon, :scope > .inbox-kind-icon'); if (!i) return null; const cs = getComputedStyle(i), b = i.getBoundingClientRect(), before = getComputedStyle(i, '::before').content.replace(/"/g, '');
        return { glyph: before && before !== 'none' ? before : i.textContent.trim(), label: i.getAttribute('aria-label'), role: i.getAttribute('role'), font: cs.fontFamily, w: Math.round(b.width), color: cs.color, bg: cs.backgroundColor }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-group-mode', 'none'); localStorage.setItem('coral-inbox-group-review-goal', 'false');` }); // Group by None: one flat list, no folded goal group
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
            await waitFor(`Object.keys(${JSON.stringify(WANT)}).every(n => [...document.querySelectorAll('${T} .nl-row')].some(r => r.textContent.includes(n)))`, at + 'the four rows', 15000);
            for (const theme of ['light', 'dark']) {
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await ev(framesJs(2));
                for (const [needle, [glyph, label]] of Object.entries(WANT)) {
                    const i = await icon(needle), what = `${at}${theme} ${needle}`;
                    check(!!i, what + ': the row has its icon');
                    if (!i) continue;
                    check(i.glyph === glyph, `${what}: the glyph is ${glyph}: ${JSON.stringify(i)}`);
                    check(i.label === label && i.role === 'img', `${what}: named "${label}" for a screen reader: ${JSON.stringify(i)}`);
                    check(/Material Icons/.test(i.font) && i.w >= 18, `${what}: drawn by the icon font in the icon column: ${JSON.stringify(i)}`);
                }
                const tiles = await ev(`(() => { const px = document.createElement('canvas').getContext('2d', { willReadFrequently: true }), rgba = c => { px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = c; px.fillRect(0, 0, 1, 1); return [...px.getImageData(0, 0, 1, 1).data]; }, behind = el => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (rgba(c)[3] > 0) return c; } return 'rgb(255, 255, 255)'; };
                    const lum = c => { const [r, g, b] = rgba(c).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }, contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
                    return ['Plan 1', 'Video review', 'Markdown review'].map(n => { const row = [...document.querySelectorAll('${T} .nl-file')].find(r => r.textContent.includes(n)), e = row && row.querySelector(':scope > .nl-icon'); if (!e) return null; const c = getComputedStyle(e); return { bg: c.backgroundColor, fg: c.color, border: c.borderColor, contrast: Math.round(contrast(c.color, behind(e)) * 100) / 100 }; }); })()`);
                check(tiles.every(Boolean) && tiles.every(t => t.bg === tiles[0].bg && t.fg === tiles[0].fg && t.border === tiles[0].border), at+theme+': HTML, video and Markdown reviews share the same icon palette: '+JSON.stringify(tiles));
                check(tiles.every(t => t && t.contrast >= 4.5), at+theme+': the file glyphs keep 4.5:1 against the row: '+JSON.stringify(tiles));
                await ev(`[...document.querySelectorAll('${T} .nl-file')].find(r => r.textContent.includes('Plan 1')).scrollIntoView({block:'start',behavior:'instant'});true`); await ev(framesJs(2));
                await shot(`needs-review-tiles-${w}-${theme}`);
            }
            await ev(`document.documentElement.removeAttribute('data-theme'); true`);
        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS review tile palette: HTML, video and Markdown match at 390/1280, light/dark; glyphs and labels retained');
})().catch(e => { console.error(e); process.exit(1); });
