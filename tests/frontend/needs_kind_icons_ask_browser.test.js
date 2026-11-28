// Needs you row icons say what is asked (#13819, the Operator: an arrow into a box on a question reads as "input", not "someone is asking you"; the approved list of #22094 draws them): a question put to the Operator (a plain one and a
// yes/no one) is a waving hand, a file for review is its type's mark (code for an HTML file), a proposal is a checklist. Real rows (article.nl-row) at 390 and 1280, light and dark; every icon is a glyph of the icon font (the list's own
// span.material-icons.nl-icon, whose only text is its glyph's name, or the kind icon .inbox-kind-icon drawn by CSS with no text), keeps its screen-reader name, and a question is not called "Needs input". The artifacts, the question and the
// proposal are stubbed. Isolated dev server. (The shared SVG file-type artwork the old table used for a file is gone by design: the approved list draws a file's type as a glyph, needs_ledger_browser.)
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const WANT = { 'Which hub': ['waving_hand', 'Question'], 'Ship batch': ['waving_hand', 'Question'], 'Plan 1': ['code', 'File for review'], 'Fix the login': ['checklist', 'To approve'] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], T = '#group-table-view', team = 'nki-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const icon = needle => ev(`(() => { const tr = [...document.querySelectorAll('${T} .nl-row')].find(r => r.textContent.includes(${JSON.stringify(needle)})); const i = tr && tr.querySelector(':scope > .nl-icon, :scope > .inbox-kind-icon'); if (!i) return null; const cs = getComputedStyle(i), b = i.getBoundingClientRect(), before = getComputedStyle(i, '::before').content.replace(/"/g, '');
        return { own: i.matches('.nl-icon'), glyph: i.matches('.nl-icon') ? i.textContent : before, before, label: i.getAttribute('aria-label'), role: i.getAttribute('role'), text: i.textContent, font: cs.fontFamily, w: Math.round(b.width), h: Math.round(b.height), shown: !!i.getClientRects().length, color: cs.color, bg: cs.backgroundColor }; })()`);
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
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': [item]}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin), m = u.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts$/);
                    if (m && m[1] === '${team}') return json({ project: m[1], artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? [item] : [], has_more: false });
                    if (u.pathname === '/api/proposals') return json({ proposals: [{ id: 11, board_id: '${team}', kind: 'task', title: 'Fix the login page on Safari', proposer: 'Backend Dev', state: 'pending', created_at: new Date(Date.now() - 5400000).toISOString(), payload: { title: 'Fix the login page on Safari', body: 'It fails on Safari.' } }] });
                    if (u.pathname === '/api/operator-asks') return json([
                        { board: '${team}', board_label: 'Acme web', kind: 'ask', id: 41, asker: 'Orchestrator', text: '@Operator Which hub do we ship to: self-hosted or app.coralhub.dev?', at: new Date(Date.now() - 7 * 60000).toISOString() },
                        { board: '${team}', board_label: 'Acme web', kind: 'ask', id: 42, asker: 'Lead Developer', text: '@Operator Ship batch-120 tonight?', at: new Date(Date.now() - 9 * 60000).toISOString(), buttons: [{ id: 1, label: 'Yes', action: 'reply', state: 'pending' }, { id: 2, label: 'No', action: 'reply', state: 'pending' }] }]);
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`Object.keys(${JSON.stringify(WANT)}).every(n => [...document.querySelectorAll('${T} .nl-row')].some(r => r.getClientRects().length && r.textContent.includes(n)))`, at + 'the four rows', 15000); } catch (e) { throw new Error(e.message + ' ' + await ev(`JSON.stringify([...document.querySelectorAll('${T} .nl-row, ${T} .nl-group-toggle')].map(r => [r.className, r.getClientRects().length, r.textContent.slice(0, 60)]))`)); }
            for (const theme of ['light', 'dark']) {
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await ev(framesJs(2));
                for (const [needle, [glyph, label]] of Object.entries(WANT)) {
                    const i = await icon(needle), what = `${at}${theme} ${needle}`;
                    check(!!i, what + ': the row has its icon');
                    if (!i) continue;
                    check(i.glyph === glyph, `${what}: the glyph is ${glyph}: ${JSON.stringify(i)}`);
                    check(i.label === label && i.role === 'img' && (i.own ? i.text === glyph && i.before === 'none' : i.text === ''), `${what}: named "${label}" for a screen reader, no text of its own but its glyph's name: ${JSON.stringify(i)}`);
                    check(i.label !== 'Needs input', `${what}: not called "Needs input"`);
                    check(/Material Icons/.test(i.font) && i.shown && i.w >= 18 && i.h >= 18, `${what}: drawn by the icon font in its 18 px column: ${JSON.stringify(i)}`);
                }
                await shot(`needs-icons-${w}-${theme}`);
            }
            await ev(`document.documentElement.removeAttribute('data-theme'); true`);
        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS Needs you icons: a question is a question mark, a file a document, a proposal a checklist, at 390 and 1280, light and dark');
})().catch(e => { console.error(e); process.exit(1); });
