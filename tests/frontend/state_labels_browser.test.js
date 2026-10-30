// Task state labels (#11356, the operator): a state is a coloured dot and its word in the same colour at normal weight, with no outline and no fill; on a phone (600 px and under) only the dot, with
// the word kept in the page as its name. Each state has its own colour (In progress and In review were both blue). One builder (data_table.js chip) serves every list; the fixture draws the states
// through the real builders (the table's chip, the team pages' stateChip, goal_words' statusClass) in a real table, so the page's own CSS decides. Light and dark, 1280 and 390.
// Drives Chrome over CDP against the isolated dev server; run_cdp_suites.mjs finds it by name. Screenshots go to $SHOTS when it is set (before/after evidence).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { auditRegion, setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const failures = [];
    const check = (name, ok, detail) => { if (ok) console.log('PASS ' + name); else { failures.push(name); console.log('FAIL ' + name + (detail ? ' - ' + detail : '')); } };
    const shot = async (name) => { if (!process.env.SHOTS) return; fs.mkdirSync(process.env.SHOTS, { recursive: true }); const r = await Page.captureScreenshot({ format: 'png' }); fs.writeFileSync(`${process.env.SHOTS}/${name}.png`, Buffer.from(r.data, 'base64')); };
    const STATES = ['Queued', 'In progress', 'In review', 'Blocked', 'Done'];
    const draw = `(async () => {
        const S = (window.__coralStatic || '/static/');
        const DT = await import(S + 'data_table.js'), W = await import(S + 'goal_words.js'), T = await import(S + 'team_table.js');
        document.getElementById('state-fixture')?.remove();
        const host = document.createElement('div'); host.id = 'state-fixture'; host.style.cssText = 'position:fixed;left:12px;top:60px;z-index:99999;width:min(560px,calc(100vw - 24px));padding:8px;background:var(--bg-primary)';
        const t = document.createElement('table'); t.className = 'dt'; const tb = document.createElement('tbody'); t.append(tb); host.append(t);
        const states = ${JSON.stringify(STATES)};
        for (const w of states) { const tr = document.createElement('tr'); const a = document.createElement('td'); a.textContent = 'Task ' + w; const b = document.createElement('td'); b.append(DT.chip(w, W.statusClass(w))); const c = document.createElement('td'); c.append(T.stateChip(w, W.statusClass(w))); tr.append(a, b, c); tb.append(tr); }
        const bad = document.createElement('tr'); const x = document.createElement('td'); x.textContent = 'A failed run'; const y = document.createElement('td'); y.append(DT.chip('Failed', 'team-state-bad')); bad.append(x, y); tb.append(bad);
        document.body.append(host); return true; })()`;
    const probe = `(() => { const host = document.getElementById('state-fixture'); const rows = [...host.querySelectorAll('tbody tr')];
        const px = v => parseFloat(v) || 0;
        return rows.map(tr => [...tr.querySelectorAll('.goal-chip')].map(c => { const cs = getComputedStyle(c), w = c.querySelector('.state-word') || c, ws = getComputedStyle(w), d = c.querySelector('.goal-dot'), r = w.getBoundingClientRect(), dr = d.getBoundingClientRect();
            return { word: c.textContent, color: cs.color, weight: cs.fontWeight, border: ['Top','Right','Bottom','Left'].map(s => px(cs['border' + s + 'Width'])).reduce((a, b) => a + b, 0), bg: cs.backgroundColor, radius: cs.borderRadius, dotColor: getComputedStyle(d).backgroundColor, dot: [Math.round(dr.width), Math.round(dr.height)], wordW: Math.round(r.width), wordH: Math.round(r.height), title: c.title, textContent: c.textContent, wordClip: ws.clipPath, aria: d.getAttribute('aria-hidden') }; })); })()`;

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, phone] of [[1280, 800, false], [390, 800, true]]) for (const theme of ['dark', 'light']) {
            const at = `${w}px ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: phone });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await setTheme(ev, theme);
            await ev(draw);
            const rows = await ev(probe);
            const labels = rows.flat();
            check(`${at}: every state is drawn by the one component (${labels.length} labels)`, labels.length === 2 * STATES.length + 1, String(labels.length));
            check(`${at}: no outline, no fill and no radius on any label`, labels.every(l => l.border === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(l.bg) && l.radius === '0px'), JSON.stringify(labels.filter(l => l.border !== 0 || !/rgba\(0, 0, 0, 0\)|transparent/.test(l.bg))[0]));
            check(`${at}: normal weight (400), never bold`, labels.every(l => l.weight === '400'), JSON.stringify([...new Set(labels.map(l => l.weight))]));
            const text = new Map(rows.map(r => [r[0].word, r[0].color]));
            check(`${at}: In progress and In review are different colours (they were both blue)`, text.get('In progress') !== text.get('In review'), `${text.get('In progress')} vs ${text.get('In review')}`);
            check(`${at}: each of the five states has its own text colour except none repeats`, new Set(STATES.map(s => text.get(s))).size === STATES.length, JSON.stringify([...text]));
            const tokens = await ev(`(() => { const probe = (v) => { const e = document.createElement('span'); e.style.color = v; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; }; return { 'In progress': probe('var(--link-text)'), 'In review': probe('var(--state-review)'), Blocked: probe('var(--warning-text)'), Done: probe('var(--success-text)'), Failed: probe('var(--error-text)'), Queued: probe('var(--text-primary)') }; })()`);
            check(`${at}: the word's colour is the state's theme token`, rows.every(r => r[0].color === tokens[r[0].word]), JSON.stringify({ tokens, got: [...text] }));
            check(`${at}: the dot is the state's own hue, 8 px`, labels.every(l => l.dot[0] === 8 && l.dot[1] === 8 && l.aria === 'true'), JSON.stringify(labels[0]));
            check(`${at}: the team page's stateChip is the same label as the table's`, rows.slice(0, 5).every(r => r[0].color === r[1].color && r[0].weight === r[1].weight && r[0].border === r[1].border));
            const audit = await auditRegion(ev, ['#state-fixture']);
            check(`${at}: text holds 4.5:1 on the row (${audit.checked} checked)`, audit.fails.length === 0, JSON.stringify(audit.fails.slice(0, 3)));
            if (phone) {
                check(`${at}: only the dot shows: the word takes no room and is clipped, but stays in the page as the name`, labels.every(l => l.wordW <= 1 && l.wordH <= 1 && l.textContent.includes(l.word) && l.title === l.word), JSON.stringify(labels[0]));
                const named = await ev(`(async () => { const c = document.querySelector('#state-fixture .goal-chip'); const { Accessibility } = {}; return c.textContent; })()`);
                check(`${at}: the accessible name is the state (${named})`, named === 'Queued');
            } else {
                check(`${at}: the word shows beside the dot`, labels.every(l => l.wordW > 8 && l.wordH > 8));
            }
            await shot(`${process.env.SHOT_TAG || 'after'}-${w}-${theme}`);
        }
    } catch (e) { console.log('ERROR ' + (e.stack || e)); failures.push('error'); }
    await client.close();
    if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
    console.log('state_labels_browser: all ok');
})();
