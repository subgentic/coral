// #21161: both read and unread card titles lead; the rail, background and accessible marker retain read state.
// File glyphs keep their non-status blue palette and at least 4.5:1 contrast in both states.
// Dark, light and automatic (OS) themes; 1280 and 390 px; two read and two unread review cards.
// On the ledger (#22094): an unread row says "New" at its side and a read row does not; the "New" words keep 4.5:1 against the row. Titles (.nl-file-open) lead in both states with the same ink, ahead of the quoted question (.nl-meta); the file glyph keeps one palette and 4.5:1 in both states.
// Retired on the ledger (#22094): the unread tinted background and 4 px rail (#21161 Operator correction): the approved Needs you mock marks an unread row only with "New" (covered here and in needs_ledger "reading first question clears its New tag"). "A screen reader hears unread and read" (.sr-only): the unread row has the words "New", not aria-hidden, and the read row has none, checked here.
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
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-theme', 'system'); localStorage.setItem('coral-inbox-group-mode', 'none'); localStorage.setItem('coral-inbox-group-review-goal', 'false');` }); // Group by None: the four files are not in a folded group // the theme the person picked is System: the page resolves it from the OS (theme_init.js)
        for (const [w, h, mobile, os] of [[1280, 900, false, 'dark'], [1280, 900, false, 'light'], [390, 800, true, 'dark'], [390, 800, true, 'light']]) { // os: the system's colour scheme, which an automatic theme follows
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: os }] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, read) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: read ? ['for review', 'read'] : ['for review'], produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = [item(1, false), item(2, true), item(3, false), item(4, true)];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .nl-row').length === 4`, `${w}: four review rows`, 15000);
            await ev(framesJs(3));
            for (const theme of ['auto', 'dark', 'light']) { // auto: the page as it loaded, following the OS
                const at = `${w} px, ${theme}${theme === 'auto' ? ' (OS ' + os + ')' : ''}: `;
                await ev(`(() => { if (!document.getElementById('__nt')) { const st = document.createElement('style'); st.id = '__nt'; st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); } if ('${theme}' !== 'auto') document.documentElement.setAttribute('data-theme', '${theme}'); return true; })()`); await ev(framesJs(4));
                if (theme === 'auto') check((await ev(`document.documentElement.getAttribute('data-theme')`)) === os, at + 'the app follows the OS colour scheme by itself: ' + await ev(`document.documentElement.getAttribute('data-theme')`));
                const m = await ev(`(() => { const px = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); const rgba = c => { px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = c; px.fillRect(0, 0, 1, 1); return [...px.getImageData(0, 0, 1, 1).data]; }; // any colour syntax, as sRGB bytes
                    const plain = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] === 255) break; } let out = [255, 255, 255]; for (const [r, g, b, a] of layers.reverse()) { const k = a / 255; out = [r * k + out[0] * (1 - k), g * k + out[1] * (1 - k), b * k + out[2] * (1 - k)]; } return 'rgb(' + out.map(Math.round).join(', ') + ')'; }; // the colour seen behind an element: its own and its ancestors' backgrounds laid over each other (a tint is see-through)
                    const lum = c => { const [r, g, b] = rgba(c).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
                    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
                    const info = n => { const tr = [...document.querySelectorAll('${T} .nl-row')].find(r => r.textContent.includes('plan-' + n + '.md')), name = tr.querySelector('.nl-file-open'), cs = getComputedStyle(name);
                        const metaEl = tr.querySelector('.nl-file-open .nl-meta'), meta = getComputedStyle(metaEl), icon = tr.querySelector(':scope > .nl-icon'), ics = getComputedStyle(icon), iconBg = rgba(ics.backgroundColor)[3] > 0 ? ics.backgroundColor : plain(icon), isNew = tr.querySelector('.nl-side .nl-new'), ns = isNew && getComputedStyle(isNew);
                        return { bgRgb: rgba(plain(name)), metaColor: meta.color, metaWeight: Number(meta.fontWeight), iconColor: ics.color, iconBg, iconContrast: contrast(ics.color, iconBg), weight: Number(cs.fontWeight), bg: plain(name), color: cs.color, contrast: contrast(cs.color, plain(name)), isNew: !!isNew && isNew.getBoundingClientRect().width > 0 && isNew.textContent.trim() === 'New', newContrast: isNew ? contrast(ns.color, plain(isNew)) : null, srNew: !!isNew && isNew.textContent.trim() === 'New' && !isNew.closest('[aria-hidden="true"]'), pill: [...tr.querySelectorAll('.dt-tag')].some(t => t.textContent.trim() === 'read'), cls: tr.className }; };
                    return { unread: info(1), read: info(2) }; })()`);
                await shot(`needs-read-state-${w}-${theme}${theme === 'auto' ? '-os-' + os : ''}`);
                check(!m.read.pill && !m.unread.pill, at + 'there is no "read" pill');
                check(m.unread.weight >= 600 && m.read.weight >= 600, at + `both unread and read titles stay prominent (#21161): ${m.unread.weight} / ${m.read.weight}`);
                check(m.unread.isNew && !m.read.isNew, at + `an unread row says "New" at its side and a read row does not: ${m.unread.isNew} / ${m.read.isNew}`);
                check(m.unread.newContrast >= 4.5, at + `the "New" words keep 4.5:1 against the row: ${m.unread.newContrast}`);
                check(m.read.color === m.unread.color && m.read.color !== m.read.metaColor && m.read.weight > m.read.metaWeight, at + `a read title leads its metadata and keeps the unread title ink (#21161): ${m.read.color} / ${m.unread.color}`);
                check(m.read.iconColor === m.unread.iconColor && m.read.iconBg === m.unread.iconBg, at + 'file icons keep one palette in both read states: ' + JSON.stringify([m.read.iconColor, m.unread.iconColor]));
                check(m.read.iconContrast >= 4.5 && m.unread.iconContrast >= 4.5, at + 'file glyph contrast is at least 4.5:1: ' + JSON.stringify(m));
                check(m.read.contrast >= 4.5 && m.unread.contrast >= 4.5, at + `contrast is at least 4.5:1: ${m.unread.contrast.toFixed(2)} / ${m.read.contrast.toFixed(2)}`);
                check(m.unread.srNew && !m.read.srNew, at + 'a screen reader still hears which row is new: the unread row has the words "New", not hidden from it, and the read row has none: ' + JSON.stringify([m.unread.srNew, m.read.srNew]));
            }
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await ev(`localStorage.removeItem('coral-inbox-needs-filters'); localStorage.removeItem('coral-theme'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_read_state_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
