// The computer of a team is its own line under the team (#12949, the Operator, with Show computer on as Coral Hub shows the Agents tab): the row read "workstation-team-m2", the computer inline with the team as one
// long name. Now the team's line is the team, and the computer is a quiet italic line under it: one line, cut with an ellipsis when long (the whole name on hover and for a screen reader), dimmed when the computer is
// down, readable (4.5:1) in both themes, inside the row at 1280 and 390 px, and with Show computer off nothing is drawn and the row is no taller than it was. Long team and computer names. The Hub's page
// state is stood in as server_switcher_browser does it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const LONG_TEAM = 'a-very-long-team-name-that-keeps-going-and-going-and-going-past-any-sidebar';
const LONG_BOX = 'studio-workstation-with-an-extremely-long-hostname.engineering.example.internal';
const SERVERS = [
    { id: 'm1', label: 'studio-mac.local', status: 'online', version: '1.4.6', last_seen: new Date().toISOString() },
    { id: 'm2', label: LONG_BOX, status: 'online', version: '1.4.6', last_seen: new Date().toISOString() },
    { id: 'm3', label: 'Old Laptop', status: 'unreachable', version: '1.3.9', last_seen: '2026-10-01T00:00:00Z', last_error: 'dial tcp: timeout' },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const scene = (show) => ev(`(() => { T.state.hub = true; T.state.cloud = true; T.state.servers = ${JSON.stringify(SERVERS)}; T.state.liveSessions = []; window.__m.agents = {};
        T.state.settings = { ...(T.state.settings || {}), show_session_server: ${show ? "'True'" : "'False'"} };
        for (const [s, team] of [['m1', 'team-m1'], ['m2', ${JSON.stringify(LONG_TEAM)}], ['m3', 'team-m3']]) window.__m.add('t-' + s, 'T', 3, { sleeping: false, server: s, board_project: team });
        T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
    const rows = () => ev(`(() => { const lum = c => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const bgOf = e => { for (let n = e; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; const m = c.match(/[\\d.]+/g); if (m && (m.length < 4 || Number(m[3]) === 1)) return c; } return 'rgb(0,0,0)'; };
        const blend = (fg, bg, a) => { const f = fg.match(/[\\d.]+/g).slice(0, 3).map(Number), b = bg.match(/[\\d.]+/g).slice(0, 3).map(Number); return 'rgb(' + f.map((v, i) => v * a + b[i] * (1 - a)).join(',') + ')'; };
        const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        return [...document.querySelectorAll('#live-sessions-list li.session-team-group, #mobile-session-list li.session-team-group')].filter(li => li.getClientRects().length).map(li => { const h = li.querySelector('.group-header-text'), n = li.querySelector('.group-name-line'), p = li.querySelector('.group-server-line'); const hb = h.getBoundingClientRect();
            const out = { team: n.textContent.trim().replace(/\\s+/g, ' '), headerH: Math.round(hb.height), hasLine: !!p };
            if (p) { const pb = p.getBoundingClientRect(), nb = n.getBoundingClientRect(), cs = getComputedStyle(p), nm = p.querySelector('.row-server-name');
                Object.assign(out, { line: nm.textContent, below: pb.top >= nb.bottom - 1, inside: pb.right <= hb.right + 1 && pb.left >= hb.left - 1, nowrap: cs.whiteSpace === 'nowrap', ellipsis: cs.textOverflow === 'ellipsis', cut: p.scrollWidth > p.clientWidth + 1, italic: cs.fontStyle, title: p.getAttribute('title'), sr: p.querySelector('.sr-only').textContent.trim(), down: p.classList.contains('is-down'), opacity: Number(cs.opacity), lineH: Math.round(pb.height),
                    contrast: Math.round(contrast(blend(cs.color, bgOf(p), Number(cs.opacity)), bgOf(p)) * 10) / 10 }); }
            return out; }); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) for (const theme of ['dark', 'light']) {
            const tag = `${w} px ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); localStorage.clear(); true`);
            await scene(false);
            const off = await rows();
            check(`${tag}: Show computer off: no computer line`, off.length === 3 && off.every(r => !r.hasLine), JSON.stringify(off));
            await scene(true);
            const on = await rows(), by = Object.fromEntries(on.map(r => [r.team.replace(/\s.*$/, ''), r]));
            check(`${tag}: each team has its computer line, and the team's line is only the team`, on.length === 3 && on.every(r => r.hasLine) && on.every(r => !/studio-|Old Laptop|workstation/.test(r.team)), JSON.stringify(on));
            const m1 = on.find(r => /^team-m1/.test(r.team)), m2 = on.find(r => /^a-very-long/.test(r.team)), m3 = on.find(r => /^team-m3/.test(r.team));
            check(`${tag}: the line is under the name, inside the header, one line, in italics`, on.every(r => r.below && r.inside && r.nowrap && r.italic === 'italic'), JSON.stringify(on.map(r => [r.team.slice(0, 12), r.below, r.inside, r.nowrap, r.italic])));
            check(`${tag}: a long computer name is cut with an ellipsis and kept whole on hover and for a screen reader`, m2 && m2.ellipsis && m2.cut && m2.title.startsWith(LONG_BOX) && LONG_BOX.startsWith(m2.line) && m2.sr === '(computer)', JSON.stringify(m2));
            check(`${tag}: a down computer is dimmed and says so`, m3 && m3.down && m3.opacity < m1.opacity && /unreachable|offline/i.test(m3.sr + m3.title), JSON.stringify([m1, m3]));
            check(`${tag}: the line is readable (4.5:1 against its row)`, on.filter(r => !r.down).every(r => r.contrast >= 4.5), JSON.stringify(on.map(r => [r.team.slice(0, 10), r.contrast, r.down])));
            check(`${tag}: a header with a computer line is taller by about one small line only`, on.every((r, i) => r.headerH - off[i].headerH <= r.lineH + 6 && r.headerH >= off[i].headerH), JSON.stringify([on.map(r => r.headerH), off.map(r => r.headerH)]));
            check(`${tag}: nothing scrolls sideways`, (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0);
            if (theme === 'dark') await shot(`computer-line-${w}`); else await shot(`computer-line-${w}-light`);
        }
    } finally { await guard.restore().catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the computer line under a team:\n  ' + problems.join('\n  '));
    console.log('PASS the computer is its own line under the team: below, one line, cut, dimmed, readable, no taller when off');
})().catch(e => { console.error(e); process.exit(1); });
