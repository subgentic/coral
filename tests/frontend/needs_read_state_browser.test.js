// Needs you reads like a mailbox (#11668, the operator's Gmail shot): the "read" pill is gone; an unread review row's name is bold on a lighter row, a read row is regular weight with muted text on the plain table; a screen
// reader still hears "unread" or "read" in the row; the muted text keeps 4.5:1 on its row. Dark and light themes, 1440 and 390. Review rows (two unread, two read) stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'readstate-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1440, 800, false], [390, 800, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, read) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: read ? ['for review', 'read'] : ['for review'], produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = [item(1, false), item(2, true), item(3, false), item(4, true)];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 4`, `${w}: four review rows`, 15000);
            await ev(framesJs(3));
            for (const theme of ['dark', 'light']) {
                const at = `${w} px, ${theme}: `;
                await ev(`(() => { if (!document.getElementById('__nt')) { const st = document.createElement('style'); st.id = '__nt'; st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); } document.documentElement.setAttribute('data-theme', '${theme}'); return true; })()`); await ev(framesJs(4));
                const m = await ev(`(() => { const px = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); const rgba = c => { px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = c; px.fillRect(0, 0, 1, 1); return [...px.getImageData(0, 0, 1, 1).data]; }; // any colour syntax, as sRGB bytes
                    const plain = el => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (rgba(c)[3] > 0) return c; } return 'rgb(255, 255, 255)'; }; // the colour behind a cell: its own or the nearest one painted
                    const lum = c => { const [r, g, b] = rgba(c).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
                    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
                    const info = n => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes('plan-' + n + '.md')), name = tr.querySelector('.inbox-review-name'), td = name.closest('td'), cs = getComputedStyle(name), tcs = getComputedStyle(td);
                        return { weight: Number(cs.fontWeight), bg: plain(name), bgLum: lum(plain(name)), color: cs.color, contrast: contrast(cs.color, plain(name)), text: (tr.querySelector('.inbox-review-item .sr-only') || {}).textContent || '', pill: [...tr.querySelectorAll('.dt-tag')].some(t => t.textContent.trim() === 'read'), cls: tr.className }; };
                    return { unread: info(1), read: info(2) }; })()`);
                await shot(`needs-read-state-${w}-${theme}`);
                check(!m.read.pill && !m.unread.pill, at + 'there is no "read" pill');
                check(m.unread.weight >= 600 && m.read.weight <= 500, at + `an unread name is bold and a read one regular: ${m.unread.weight} / ${m.read.weight}`);
                check(m.unread.bgLum > m.read.bgLum, at + `an unread row is lighter than a read one: ${m.unread.bg} / ${m.read.bg}`);
                check(m.read.color !== m.unread.color, at + `a read row's text is muted: ${m.read.color} / ${m.unread.color}`);
                check(m.read.contrast >= 4.5 && m.unread.contrast >= 4.5, at + `contrast is at least 4.5:1: ${m.unread.contrast.toFixed(2)} / ${m.read.contrast.toFixed(2)}`);
                check(/unread/.test(m.unread.text) && /read/.test(m.read.text) && !/unread/.test(m.read.text), at + 'a screen reader still hears unread and read');
            }
            await ev(`document.documentElement.removeAttribute('data-theme'); true`);
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_read_state_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
